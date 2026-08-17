/**
 * Integration tests for the admin user-management + role-limit endpoints.
 *
 * The DB, limits resolver, storage driver, Discord API, and auth middlewares
 * are mocked so no external connections are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  mockSelectResult,
  mockUpdateReturning,
  mockDeleteWhere,
  mockInsertValues,
  mockGetRoleConfig,
  mockResolveQuotaBytes,
  mockInvalidateRoleConfig,
  mockStorageDeleteFile,
  mockFetchGuildRoles,
} = vi.hoisted(() => ({
  mockSelectResult: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockDeleteWhere: vi.fn().mockResolvedValue([]),
  mockInsertValues: vi.fn().mockResolvedValue([]),
  mockGetRoleConfig: vi.fn().mockResolvedValue([]),
  mockResolveQuotaBytes: vi.fn().mockReturnValue(5 * 1_073_741_824),
  mockInvalidateRoleConfig: vi.fn(),
  mockStorageDeleteFile: vi.fn().mockResolvedValue(undefined),
  mockFetchGuildRoles: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  // Flexible select chain supporting the two shapes the admin route uses:
  //   .select().from(t).where(...)                                   (single user / clips)
  //   .select({...}).from(t).leftJoin(...).groupBy(...).orderBy(...) (users list)
  const selectFrom = () => ({
    where: () => mockSelectResult(),
    orderBy: () => mockSelectResult(),
    leftJoin: () => ({
      groupBy: () => ({
        orderBy: () => mockSelectResult(),
      }),
    }),
  });
  const mockSelect = vi.fn(() => ({ from: selectFrom }));

  const mockSet = vi.fn(() => ({
    where: () => ({
      returning: mockUpdateReturning,
    }),
  }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));

  // delete is thenable so `await db.delete(table)` (delete-all, used by the
  // role-limits PUT) resolves, while `.where(fn)` still returns a promise for
  // the single-row delete used by the user DELETE route.
  const mockDelete = vi.fn(() => ({
    where: mockDeleteWhere,
    then: (resolve: () => unknown) => {
      mockDeleteWhere();
      return Promise.resolve(undefined).then(resolve);
    },
  }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  return {
    db: { select: mockSelect, update: mockUpdate, delete: mockDelete, insert: mockInsert },
    siteSettingsTable: {},
    usersTable: {},
    clipsTable: {},
    discordRolesTable: {},
  };
});

vi.mock("../lib/site-settings", () => ({
  getSiteSettings: vi.fn().mockResolvedValue({
    id: 1,
    discordGuildId: "guild-1",
    discordShareChannelId: null,
    maxUploadBytes: 1_073_741_824,
    maxUserStorageBytes: 5 * 1_073_741_824,
  }),
}));

vi.mock("../lib/limits", () => ({
  getRoleConfig: mockGetRoleConfig,
  resolveQuotaBytes: mockResolveQuotaBytes,
  invalidateRoleConfig: mockInvalidateRoleConfig,
}));

vi.mock("../lib/storage", () => ({
  getStorageDriver: vi.fn(() => ({
    deleteFile: mockStorageDeleteFile,
  })),
}));

vi.mock("../lib/discord", () => ({
  checkDiscordBotToken: vi.fn().mockResolvedValue(true),
  fetchGuildRoles: mockFetchGuildRoles,
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  isAdminDiscordId: vi.fn((id: string) => id === "admin-id"),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { db } from "@workspace/db";
import { invalidateRoleConfig } from "../lib/limits";
import { fetchGuildRoles } from "../lib/discord";
import adminRouter from "./admin";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  return app;
}

const USER = {
  id: 1,
  discordId: "user-id",
  username: "alice",
  avatarUrl: null,
  usedStorageBytes: 1024,
  quotaOverrideBytes: null,
  roles: [],
  banned: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRoleConfig.mockResolvedValue([]);
  mockResolveQuotaBytes.mockReturnValue(5 * 1_073_741_824);
});

describe("GET /admin/users", () => {
  it("lists users with resolved quota and clip counts", async () => {
    mockSelectResult.mockResolvedValue([
      { user: { ...USER, createdAt: new Date("2026-01-01T00:00:00Z") }, clipCount: 3 },
    ]);

    const res = await request(buildApp()).get("/admin/users");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 1,
      username: "alice",
      clipCount: 3,
      banned: false,
      isAdmin: false,
      quotaStorageBytes: 5 * 1_073_741_824,
    });
  });

  it("marks the admin's own account with isAdmin: true", async () => {
    mockSelectResult.mockResolvedValue([
      { user: { ...USER, discordId: "admin-id", createdAt: new Date("2026-01-01T00:00:00Z") }, clipCount: 0 },
    ]);

    const res = await request(buildApp()).get("/admin/users");

    expect(res.body[0].isAdmin).toBe(true);
  });
});

describe("PATCH /admin/users/:id", () => {
  it("bans a user", async () => {
    mockUpdateReturning.mockResolvedValue([{ ...USER, banned: true }]);
    mockSelectResult.mockResolvedValue([{ clipCount: 0 }]);

    const res = await request(buildApp())
      .patch("/admin/users/1")
      .send({ banned: true });

    expect(res.status).toBe(200);
    expect(res.body.banned).toBe(true);
    const updateSet = vi.mocked(db.update).mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    expect(updateSet.mock.calls[0]?.[0]).toEqual({ banned: true });
  });

  it("clears a quota override with null", async () => {
    mockUpdateReturning.mockResolvedValue([{ ...USER, quotaOverrideBytes: null }]);
    mockSelectResult.mockResolvedValue([{ clipCount: 0 }]);

    const res = await request(buildApp())
      .patch("/admin/users/1")
      .send({ quotaOverrideBytes: null });

    expect(res.status).toBe(200);
    const updateSet = vi.mocked(db.update).mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    expect(updateSet.mock.calls[0]?.[0]).toEqual({ quotaOverrideBytes: null });
  });

  it("returns 404 when the user does not exist", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    const res = await request(buildApp())
      .patch("/admin/users/999")
      .send({ banned: true });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/users/:id", () => {
  it("deletes the user's clip files then the user row", async () => {
    // First select → the user exists; second select → their clips.
    mockSelectResult
      .mockResolvedValueOnce([USER])
      .mockResolvedValueOnce([
        { storageKey: "clips/a.mp4", thumbnailKey: "clips/a-thumb.jpg" },
      ]);

    const res = await request(buildApp()).delete("/admin/users/1");

    expect(res.status).toBe(204);
    expect(mockStorageDeleteFile).toHaveBeenCalledWith("clips/a.mp4");
    expect(mockStorageDeleteFile).toHaveBeenCalledWith("clips/a-thumb.jpg");
    expect(mockDeleteWhere).toHaveBeenCalled();
  });

  it("returns 404 when the user does not exist", async () => {
    mockSelectResult.mockResolvedValueOnce([]);

    const res = await request(buildApp()).delete("/admin/users/999");

    expect(res.status).toBe(404);
    expect(mockStorageDeleteFile).not.toHaveBeenCalled();
  });
});

describe("GET /admin/discord/guild-roles", () => {
  it("returns guild roles from Discord", async () => {
    mockFetchGuildRoles.mockResolvedValue([
      { id: "1", name: "@everyone", position: 0 },
      { id: "2", name: "VIP", position: 5 },
    ]);

    const res = await request(buildApp()).get("/admin/discord/guild-roles");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "1", name: "@everyone", position: 0 },
      { id: "2", name: "VIP", position: 5 },
    ]);
  });

  it("propagates a Discord API failure as 502", async () => {
    mockFetchGuildRoles.mockRejectedValue(new Error("Failed to fetch Discord guild roles"));

    const res = await request(buildApp()).get("/admin/discord/guild-roles");

    expect(res.status).toBe(502);
  });
});

describe("PUT /admin/discord/role-limits", () => {
  it("replaces the config, invalidates the cache, and returns the saved rows", async () => {
    mockSelectResult.mockResolvedValue([
      { roleId: "2", roleName: "VIP", priority: 10, maxUploadBytes: 500_000_000, maxUserStorageBytes: null },
    ]);

    const res = await request(buildApp())
      .put("/admin/discord/role-limits")
      .send([
        { roleId: "2", roleName: "VIP", priority: 10, maxUploadBytes: 500_000_000, maxUserStorageBytes: null },
      ]);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // Delete-then-insert: the whole config is replaced.
    expect(mockDeleteWhere).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalled();
    expect(mockInvalidateRoleConfig).toHaveBeenCalled();
  });
});
