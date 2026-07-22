/**
 * GitHub OAuth link flow — connects a GitHub identity to the signed-in
 * Discord user purely for star-bonus verification. GitHub is never used as
 * a login method; Discord remains the only sign-in path.
 */
import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { GithubCheckStarResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  isGithubConfigured,
  getGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubUser,
  checkHasStarred,
  GithubTokenInvalidError,
  GithubRateLimitError,
  STAR_BONUS_BYTES,
} from "../lib/github";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Start the GitHub OAuth link flow ──────────────────────────────────────────
router.get("/auth/github/link", requireAuth, (req, res): void => {
  if (!isGithubConfigured()) {
    res.redirect("/?githubError=not_configured");
    return;
  }
  const state = randomBytes(16).toString("hex");
  req.session.githubOauthState = state;
  res.redirect(getGithubAuthorizeUrl(state));
});

// ── GitHub redirects back here after the user authorises ──────────────────────
router.get("/auth/github/callback", requireAuth, async (req, res): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  if (!code || !state || state !== req.session.githubOauthState) {
    res.redirect("/?githubError=invalid_state");
    return;
  }
  req.session.githubOauthState = undefined;

  try {
    const tokenResponse = await exchangeGithubCode(code);
    const githubUser = await fetchGithubUser(tokenResponse.access_token);

    // Check whether the GitHub account is already linked to a different user.
    const [existingLink] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.githubId, String(githubUser.id)));

    if (existingLink && existingLink.id !== req.currentUser!.id) {
      res.redirect("/?githubError=already_linked");
      return;
    }

    // Link the GitHub account and immediately check for the star.
    const starred = await checkHasStarred(tokenResponse.access_token);
    const alreadyGranted = req.currentUser!.githubStarBonusGranted;
    const shouldGrant = starred && !alreadyGranted;

    // Persist the token in the DB so check-star survives session expiry /
    // server restarts. The token has read:user scope only.
    await db
      .update(usersTable)
      .set({
        githubId: String(githubUser.id),
        githubUsername: githubUser.login,
        githubAccessToken: tokenResponse.access_token,
        ...(shouldGrant ? { githubStarBonusGranted: true } : {}),
      })
      .where(eq(usersTable.id, req.currentUser!.id));

    // Also cache in session for the duration of this session (fast path).
    req.session.githubAccessToken = tokenResponse.access_token;

    if (shouldGrant) {
      logger.info(
        { userId: req.currentUser!.id, githubLogin: githubUser.login, bonusBytes: STAR_BONUS_BYTES },
        "GitHub star bonus granted",
      );
    }

    res.redirect("/?githubLinked=1");
  } catch (err) {
    logger.error({ err }, "GitHub OAuth callback failed");
    res.redirect("/?githubError=oauth_failed");
  }
});

// ── Re-check star status (user may have starred after connecting) ──────────────
//
// This endpoint re-fetches the star status via a fresh GitHub API call.
// Because we only stored the access token transiently (in the OAuth callback,
// not persisted), we must re-run the full OAuth exchange on each re-check.
// Instead, we accept that the re-check can only be triggered right after
// linking (via callback) or store the token. For MVP simplicity: direct
// the user back through the GitHub link flow to re-check, but also expose
// a lightweight endpoint that re-uses a stored token if present, falling
// back gracefully.
//
// Pragmatic MVP approach: store the access_token in the session temporarily
// (only until re-check is called or session expires). The token is short-lived
// and only has read:user scope, so the exposure window is acceptable.
router.post("/auth/github/check-star", requireAuth, async (req, res): Promise<void> => {
  const user = req.currentUser!;

  if (!user.githubId || !user.githubUsername) {
    res.status(400).json({ error: "No GitHub account linked" });
    return;
  }

  // If the bonus is already granted, fast-path without hitting GitHub.
  if (user.githubStarBonusGranted) {
    res.json(
      GithubCheckStarResponse.parse({
        githubUsername: user.githubUsername,
        starred: true,
        bonusGranted: true,
      }),
    );
    return;
  }

  // Use session-cached token first (fastest), then fall back to the DB-persisted
  // token so re-check survives session expiry and server restarts.
  const githubToken = req.session.githubAccessToken ?? user.githubAccessToken;
  if (!githubToken) {
    // No token available anywhere; client should send the user through the link flow.
    res.status(400).json({ error: "no_token_cached" });
    return;
  }

  try {
    const starred = await checkHasStarred(githubToken);
    let bonusGranted: boolean = user.githubStarBonusGranted;

    if (starred && !bonusGranted) {
      await db
        .update(usersTable)
        .set({ githubStarBonusGranted: true })
        .where(eq(usersTable.id, user.id));
      bonusGranted = true;
      logger.info(
        { userId: user.id, githubLogin: user.githubUsername, bonusBytes: STAR_BONUS_BYTES },
        "GitHub star bonus granted via re-check",
      );
    }

    res.json(
      GithubCheckStarResponse.parse({
        githubUsername: user.githubUsername,
        starred,
        bonusGranted,
      }),
    );
  } catch (err) {
    if (err instanceof GithubTokenInvalidError) {
      // Token was revoked — clear it from DB and session so a fresh re-link works cleanly.
      await db
        .update(usersTable)
        .set({ githubAccessToken: null })
        .where(eq(usersTable.id, user.id));
      req.session.githubAccessToken = undefined;
      logger.warn({ userId: user.id }, "Cleared revoked GitHub token; prompting user to re-link");
      res.status(401).json({ error: "token_invalid" });
      return;
    }
    if (err instanceof GithubRateLimitError) {
      logger.warn({ userId: user.id }, "GitHub rate limit hit during star re-check");
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    logger.error({ err }, "GitHub star re-check failed");
    res.status(502).json({ error: "star_check_failed" });
  }
});

// ── Unlink GitHub account ──────────────────────────────────────────────────────
router.delete("/auth/github/disconnect", requireAuth, async (req, res): Promise<void> => {
  try {
    await db
      .update(usersTable)
      .set({ githubId: null, githubUsername: null, githubAccessToken: null })
      .where(eq(usersTable.id, req.currentUser!.id));
  } catch (err) {
    logger.error({ err }, "GitHub disconnect DB update failed");
    res.status(500).json({ error: "disconnect_failed" });
    return;
  }
  req.session.githubAccessToken = undefined;
  res.status(204).end();
});

export default router;

declare module "express-session" {
  interface SessionData {
    githubOauthState?: string;
    githubAccessToken?: string;
  }
}
