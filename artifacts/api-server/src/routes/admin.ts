import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  siteSettingsTable,
  usersTable,
  clipsTable,
  discordRolesTable,
  type SiteSettingsRow,
  type User,
  type DiscordRole,
} from "@workspace/db";
import {
  GetAdminSettingsResponse,
  UpdateAdminSettingsBody,
  UpdateAdminSettingsResponse,
  ListAdminUsersResponse,
  UpdateAdminUserBody,
  UpdateAdminUserResponse,
  ListDiscordGuildRolesResponse,
  ListDiscordRoleLimitsResponse,
  UpdateDiscordRoleLimitsBody,
  UpdateDiscordRoleLimitsResponse,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin, isAdminDiscordId } from "../middlewares/auth";
import { getSiteSettings } from "../lib/site-settings";
import { checkDiscordBotToken, fetchGuildRoles } from "../lib/discord";
import { getRoleConfig, resolveQuotaBytes, invalidateRoleConfig } from "../lib/limits";
import { getStorageDriver } from "../lib/storage";

const router: IRouter = Router();

function configFlags() {
  return {
    githubBonusEnabled: !!(
      process.env.GITHUB_CLIENT_ID &&
      process.env.GITHUB_CLIENT_SECRET &&
      process.env.GITHUB_REDIRECT_URI
    ),
    discordEnabled: !!(
      process.env.DISCORD_CLIENT_ID &&
      process.env.DISCORD_CLIENT_SECRET &&
      process.env.DISCORD_REDIRECT_URI
    ),
  };
}

/** Bot token status is validated against Discord on each read (cached). */
async function resolveDiscordBotEnabled(): Promise<boolean> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  return botToken ? checkDiscordBotToken(botToken) : false;
}

router.get("/admin/settings", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getSiteSettings();
  res.json(
    GetAdminSettingsResponse.parse({
      ...settings,
      ...configFlags(),
      discordBotEnabled: await resolveDiscordBotEnabled(),
    }),
  );
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

  res.json(
    UpdateAdminSettingsResponse.parse({
      ...updated,
      ...configFlags(),
      discordBotEnabled: await resolveDiscordBotEnabled(),
    }),
  );
});

// ── User management ──────────────────────────────────────────────────────────

function serializeAdminUser(
  user: User,
  settings: SiteSettingsRow,
  roleConfig: DiscordRole[],
  clipCount: number,
): unknown {
  return {
    id: user.id,
    discordId: user.discordId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    usedStorageBytes: user.usedStorageBytes,
    quotaStorageBytes: resolveQuotaBytes(settings, roleConfig, user),
    quotaOverrideBytes: user.quotaOverrideBytes,
    roles: user.roles ?? [],
    banned: user.banned,
    isAdmin: isAdminDiscordId(user.discordId),
    clipCount,
    createdAt: user.createdAt.toISOString(),
  };
}

async function serializeSingleAdminUser(user: User): Promise<unknown> {
  const settings = await getSiteSettings();
  const roleConfig = await getRoleConfig();
  const [countRow] = await db
    .select({ clipCount: sql<number>`count(${clipsTable.id})::int` })
    .from(clipsTable)
    .where(eq(clipsTable.ownerId, user.id));
  return serializeAdminUser(user, settings, roleConfig, countRow?.clipCount ?? 0);
}

router.get("/admin/users", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getSiteSettings();
  const roleConfig = await getRoleConfig();

  const rows = await db
    .select({
      user: usersTable,
      clipCount: sql<number>`count(${clipsTable.id})::int`,
    })
    .from(usersTable)
    .leftJoin(clipsTable, eq(clipsTable.ownerId, usersTable.id))
    .groupBy(usersTable.id)
    .orderBy(usersTable.createdAt);

  res.json(
    ListAdminUsersResponse.parse(
      rows.map(({ user, clipCount }) =>
        serializeAdminUser(user, settings, roleConfig, clipCount),
      ),
    ),
  );
});

router.patch("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = UpdateAdminUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(parsed.data)
    .where(eq(usersTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateAdminUserResponse.parse(await serializeSingleAdminUser(updated)));
});

router.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Delete the user's clip files from storage first. The rows themselves are
  // removed by the clips.owner_id FK ON DELETE CASCADE when the user row goes.
  const clips = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.ownerId, id));
  const storage = getStorageDriver();
  for (const clip of clips) {
    await storage.deleteFile(clip.storageKey).catch(() => {});
    if (clip.thumbnailKey) {
      await storage.deleteFile(clip.thumbnailKey).catch(() => {});
    }
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.status(204).end();
});

// ── Discord role limits ──────────────────────────────────────────────────────

router.get("/admin/discord/guild-roles", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getSiteSettings();
  if (!settings.discordGuildId) {
    res.status(400).json({ error: "No Discord guild is configured" });
    return;
  }
  try {
    const roles = await fetchGuildRoles(settings.discordGuildId);
    res.json(
      ListDiscordGuildRolesResponse.parse(
        roles.map((r) => ({ id: r.id, name: r.name, position: r.position })),
      ),
    );
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to fetch Discord guild roles",
    });
  }
});

router.get("/admin/discord/role-limits", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(discordRolesTable)
    .orderBy(discordRolesTable.priority);
  res.json(
    ListDiscordRoleLimitsResponse.parse(
      rows.map((r) => ({
        roleId: r.roleId,
        roleName: r.roleName,
        priority: r.priority,
        maxUploadBytes: r.maxUploadBytes,
        maxUserStorageBytes: r.maxUserStorageBytes,
      })),
    ),
  );
});

router.put("/admin/discord/role-limits", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdateDiscordRoleLimitsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Replace the whole config: delete existing rows then insert the new set.
  await db.delete(discordRolesTable);
  if (parsed.data.length > 0) {
    await db
      .insert(discordRolesTable)
      .values(
        parsed.data.map((r) => ({
          roleId: r.roleId,
          roleName: r.roleName,
          priority: r.priority,
          maxUploadBytes: r.maxUploadBytes,
          maxUserStorageBytes: r.maxUserStorageBytes,
        })),
      );
  }
  invalidateRoleConfig();

  const rows = await db
    .select()
    .from(discordRolesTable)
    .orderBy(discordRolesTable.priority);
  res.json(
    UpdateDiscordRoleLimitsResponse.parse(
      rows.map((r) => ({
        roleId: r.roleId,
        roleName: r.roleName,
        priority: r.priority,
        maxUploadBytes: r.maxUploadBytes,
        maxUserStorageBytes: r.maxUserStorageBytes,
      })),
    ),
  );
});

export default router;
