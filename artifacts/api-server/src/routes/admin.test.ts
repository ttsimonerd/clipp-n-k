/**
 * Unit tests for GET /admin/settings — verifying that the `discordEnabled`
 * and `discordBotEnabled` flags are computed correctly.
 *
 * The database, auth middlewares, and Discord API are mocked; no external
 * connections are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import request from "supertest";

// ── Module mocks ──────────────────────────────────────────────────────────────

const { mockSettings, mockCheckDiscordBotToken } = vi.hoisted(() => ({
  mockSettings: {
    id: 1,
    discordGuildId: null,
    brandingTitle: "Test Instance",
    brandingLogoUrl: null,
    brandingPrimaryColor: "#5865F2",
    maxUploadBytes: 1_073_741_824,
    maxUserStorageBytes: 1_073_741_824,
    maxClipDurationSeconds: null,
    allowedMimeTypes: ["video/mp4"],
    defaultVisibility: "private",
    updatedAt: new Date(),
  },
  mockCheckDiscordBotToken: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/site-settings", () => ({
  getSiteSettings: vi.fn().mockResolvedValue(mockSettings),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  siteSettingsTable: {},
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/discord", () => ({
  checkDiscordBotToken: mockCheckDiscordBotToken,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import adminRouter from "./admin";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: true }));
  app.use(adminRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/settings — discordEnabled flag", () => {
  const DISCORD_VARS = {
    DISCORD_CLIENT_ID: "fake-client-id",
    DISCORD_CLIENT_SECRET: "fake-client-secret",
    DISCORD_REDIRECT_URI: "https://example.com/api/auth/discord/callback",
  };

  beforeEach(() => {
    // Start with no Discord env vars set
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_REDIRECT_URI;
    // Clear irrelevant GitHub vars
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_REDIRECT_URI;
    delete process.env.DISCORD_BOT_TOKEN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_REDIRECT_URI;
  });

  it("returns discordEnabled: true when all three Discord OAuth vars are set", async () => {
    Object.assign(process.env, DISCORD_VARS);

    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordEnabled).toBe(true);
  });

  it("returns discordEnabled: false when DISCORD_CLIENT_ID is missing", async () => {
    process.env.DISCORD_CLIENT_SECRET = DISCORD_VARS.DISCORD_CLIENT_SECRET;
    process.env.DISCORD_REDIRECT_URI = DISCORD_VARS.DISCORD_REDIRECT_URI;

    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordEnabled).toBe(false);
  });

  it("returns discordEnabled: false when DISCORD_CLIENT_SECRET is missing", async () => {
    process.env.DISCORD_CLIENT_ID = DISCORD_VARS.DISCORD_CLIENT_ID;
    process.env.DISCORD_REDIRECT_URI = DISCORD_VARS.DISCORD_REDIRECT_URI;

    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordEnabled).toBe(false);
  });

  it("returns discordEnabled: false when DISCORD_REDIRECT_URI is missing", async () => {
    process.env.DISCORD_CLIENT_ID = DISCORD_VARS.DISCORD_CLIENT_ID;
    process.env.DISCORD_CLIENT_SECRET = DISCORD_VARS.DISCORD_CLIENT_SECRET;

    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordEnabled).toBe(false);
  });

  it("returns discordEnabled: false when none of the Discord OAuth vars are set", async () => {
    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordEnabled).toBe(false);
  });
});

// ── discordBotEnabled tests ───────────────────────────────────────────────────

describe("GET /admin/settings — discordBotEnabled flag", () => {
  beforeEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_REDIRECT_URI;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_REDIRECT_URI;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.DISCORD_BOT_TOKEN;
  });

  it("returns discordBotEnabled: false when DISCORD_BOT_TOKEN is not set", async () => {
    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordBotEnabled).toBe(false);
    // checkDiscordBotToken must NOT be called when there is no token
    expect(mockCheckDiscordBotToken).not.toHaveBeenCalled();
  });

  it("returns discordBotEnabled: true when the token is set and Discord accepts it", async () => {
    process.env.DISCORD_BOT_TOKEN = "valid-bot-token";
    mockCheckDiscordBotToken.mockResolvedValueOnce(true);

    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordBotEnabled).toBe(true);
    expect(mockCheckDiscordBotToken).toHaveBeenCalledWith("valid-bot-token");
  });

  it("returns discordBotEnabled: false when the token is set but Discord rejects it", async () => {
    process.env.DISCORD_BOT_TOKEN = "bad-bot-token";
    mockCheckDiscordBotToken.mockResolvedValueOnce(false);

    const res = await request(buildApp()).get("/admin/settings");

    expect(res.status).toBe(200);
    expect(res.body.discordBotEnabled).toBe(false);
    expect(mockCheckDiscordBotToken).toHaveBeenCalledWith("bad-bot-token");
  });
});
