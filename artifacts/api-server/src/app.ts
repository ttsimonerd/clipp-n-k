import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
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
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(loadCurrentUser);

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

export default app;
