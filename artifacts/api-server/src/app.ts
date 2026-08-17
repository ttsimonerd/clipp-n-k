import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import shareRouter from "./routes/share";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";
import { loadCurrentUser } from "./middlewares/auth";

const app: Express = express();

// Behind Coolify's Traefik proxy so secure cookies and req.protocol are
// computed correctly. `true` trusts X-Forwarded-* headers regardless of
// hop count, which is safe here since this app only ever sits behind one
// reverse proxy in self-hosted deployments.
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── CORS ─────────────────────────────────────────────────────────────────────
// The SPA and API are served from the same origin in every supported
// deployment (nginx proxies /api in Docker; Replit's router serves both), so
// production sends NO CORS headers at all — browsers then block cross-origin
// credentialed reads entirely. Dev mode (Vite on a separate port) still needs
// the wide-open reflect-everything behavior. Set CORS_ORIGIN to pin an
// allowlist if you ever serve the SPA from a different origin.
const corsOrigins = process.env.CORS_ORIGIN?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    credentials: true,
    origin: corsOrigins
      ? corsOrigins
      : process.env.NODE_ENV === "production"
        ? false
        : true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(loadCurrentUser);

// ── Rate limiting (best-effort abuse mitigation) ─────────────────────────────
// No rate limiting existed before; without it, anyone can hammer the OAuth
// entry points and upload endpoints. Limits are generous so legitimate users
// (including shared/NAT IPs) aren't affected.
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests — try again shortly" },
  }),
);
app.use(
  "/api/clips",
  rateLimit({
    // Generous enough for multi-file batch uploads (the dialog uploads with a
    // small concurrency), while still throttling naive abuse. ffmpeg CPU is
    // bounded separately by the processing queue's concurrency cap.
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests — try again shortly" },
  }),
);

// NOTE: clip video/thumbnail files are intentionally NOT served via a
// blanket static/public route. Storage keys are deterministic
// (clips/{slug}.mp4), so a static mount here would let anyone who learns a
// private clip's key fetch it directly, bypassing visibility/ownership
// checks. Media is instead streamed through routes that re-check
// visibility/ownership on every request:
//   - /api/clips/:id/video, /api/clips/:id/thumbnail (owner-authenticated)
//   - /api/public/clips/:slug/video, /api/public/clips/:slug/thumbnail
//     (re-checks visibility=public on every request)
app.use("/api", router);
app.use("/c", shareRouter);

// Unknown API routes → JSON (Express's default HTML 404 leaks nothing but
// is wrong for an API).
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// JSON error handler: async route errors (Express 5 forwards them here)
// previously fell through to Express's HTML 500 page.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const candidate = err as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status =
    typeof candidate.status === "number" && candidate.status >= 400 && candidate.status < 500
      ? candidate.status
      : typeof candidate.statusCode === "number" && candidate.statusCode >= 400 && candidate.statusCode < 500
        ? candidate.statusCode
        : 500;

  if (status >= 500) {
    logger.error({ err }, "Unhandled request error");
    res.status(status).json({ error: "Internal server error" });
    return;
  }
  res.status(status).json({ error: "Bad request" });
});

export default app;
