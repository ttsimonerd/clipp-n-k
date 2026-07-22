import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { GetMeResponse } from "@workspace/api-zod";
import {
  getDiscordAuthorizeUrl,
  exchangeDiscordCode,
  fetchDiscordUser,
  discordAvatarUrl,
  userIsInGuild,
} from "../lib/discord";
import { getSiteSettings } from "../lib/site-settings";
import { isAdminDiscordId } from "../middlewares/auth";
import { effectiveQuotaBytes } from "../lib/quota";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/auth/discord/login", (req, res): void => {
  const state = randomBytes(16).toString("hex");

  req.session.oauthState = state;

  req.session.save((err) => {
    if (err) {
      logger.error({ err }, "Failed to save OAuth session");
      res.redirect("/?authError=session_error");
      return;
    }

    res.redirect(getDiscordAuthorizeUrl(state));
  });
});

router.get("/auth/discord/callback", async (req, res): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  if (!code || !state || state !== req.session.oauthState) {
    res.redirect("/?authError=invalid_state");
    return;
  }
  req.session.oauthState = undefined;

  try {
    const tokenResponse = await exchangeDiscordCode(code);
    const discordUser = await fetchDiscordUser(tokenResponse.access_token);

    const settings = await getSiteSettings();
    if (settings.discordGuildId) {
      let isMember: boolean;
      try {
        isMember = await userIsInGuild(
          tokenResponse.access_token,
          settings.discordGuildId,
        );
      } catch (guildErr) {
        logger.error({ err: guildErr }, "Discord guild API outage during login — could not verify guild membership");
        res.redirect("/?authError=guild_check_failed");
        return;
      }
      if (!isMember) {
        res.redirect("/?authError=not_member");
        return;
      }
    }

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.discordId, discordUser.id));

    const avatarUrl = discordAvatarUrl(discordUser);

    let userId: number;
    if (existing) {
      const [updated] = await db
        .update(usersTable)
        .set({ username: discordUser.username, avatarUrl })
        .where(eq(usersTable.id, existing.id))
        .returning();
      userId = updated!.id;
    } else {
      const [created] = await db
        .insert(usersTable)
        .values({
          discordId: discordUser.id,
          username: discordUser.username,
          avatarUrl,
        })
        .returning();
      userId = created!.id;
    }

    req.session.userId = userId;
    res.redirect("/");
  } catch (err) {
    logger.error({ err }, "Discord OAuth callback failed");
    res.redirect("/?authError=oauth_failed");
  }
});

router.get("/auth/me", async (req, res): Promise<void> => {
  if (!req.currentUser) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  const user = req.currentUser;
  // Quota is computed dynamically from admin-configurable site settings,
  // not stored per-user, so admin changes apply immediately.
  const settings = await getSiteSettings();
  const data = GetMeResponse.parse({
    id: user.id,
    discordId: user.discordId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    isAdmin: isAdminDiscordId(user.discordId),
    usedStorageBytes: user.usedStorageBytes,
    quotaStorageBytes: effectiveQuotaBytes(user, settings),
    githubUsername: user.githubUsername ?? null,
    githubStarBonusGranted: user.githubStarBonusGranted,
  });
  res.json(data);
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, "Failed to destroy session");
    }
    res.clearCookie("clippnk.sid");
    res.status(204).end();
  });
});

export default router;

declare module "express-session" {
  interface SessionData {
    oauthState?: string;
  }
}
