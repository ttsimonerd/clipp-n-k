import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, siteSettingsTable } from "@workspace/db";
import { GetAdminSettingsResponse, UpdateAdminSettingsBody, UpdateAdminSettingsResponse } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/auth";
import { getSiteSettings } from "../lib/site-settings";
import { checkDiscordBotToken } from "../lib/discord";

const router: IRouter = Router();

router.get("/admin/settings", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getSiteSettings();
  const githubBonusEnabled = !!(
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.GITHUB_REDIRECT_URI
  );
  const discordEnabled = !!(
    process.env.DISCORD_CLIENT_ID &&
    process.env.DISCORD_CLIENT_SECRET &&
    process.env.DISCORD_REDIRECT_URI
  );
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const discordBotEnabled = botToken ? await checkDiscordBotToken(botToken) : false;
  res.json(GetAdminSettingsResponse.parse({ ...settings, githubBonusEnabled, discordEnabled, discordBotEnabled }));
});

router.patch("/admin/settings", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateAdminSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await getSiteSettings(); // ensure the row exists

  const [updated] = await db
    .update(siteSettingsTable)
    .set(parsed.data)
    .where(eq(siteSettingsTable.id, 1))
    .returning();

  const githubBonusEnabled = !!(
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.GITHUB_REDIRECT_URI
  );
  const discordEnabled = !!(
    process.env.DISCORD_CLIENT_ID &&
    process.env.DISCORD_CLIENT_SECRET &&
    process.env.DISCORD_REDIRECT_URI
  );
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const discordBotEnabled = botToken ? await checkDiscordBotToken(botToken) : false;
  res.json(UpdateAdminSettingsResponse.parse({ ...updated, githubBonusEnabled, discordEnabled, discordBotEnabled }));
});

export default router;
