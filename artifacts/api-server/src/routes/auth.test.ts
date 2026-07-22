/**
 * Integration tests for the Discord OAuth auth routes.
 *
 * The database, Discord API, site-settings, and session store are all mocked;
 * no external connections are made.
 *
 * Covers:
 *   GET /auth/discord/login    — redirects to Discord with a state cookie
 *   GET /auth/discord/callback — state validation, missing-env-var error,
 *                                guild-membership check, new-user creation,
 *                                existing-user update, and session hydration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import request from "supertest";

// ── Hoisted mocks (must come before vi.mock calls) ────────────────────────────

/**
 * `mockSelectWhere` is the terminal `.where()` call in the
 * `db.select().from(…).where(…)` chain used by the callback handler to check
 * for an existing user. Hoisting lets us control its resolved value per-test.
 */
const { mockSelectWhere, mockInsertReturning, mockUpdateReturning } = vi.hoisted(() => {
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockInsertReturning = vi.fn().mockResolvedValue([{ id: 1 }]);
  const mockUpdateReturning = vi.fn().mockResolvedValue([{ id: 1 }]);
  return { mockSelectWhere, mockInsertReturning, mockUpdateReturning };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  // insert chain: db.insert(table).values({…}).returning()
  const mockValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));

  // update chain: db.update(table).set({…}).where(…).returning()
  const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
  const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockSet }));

  // select chain: db.select().from(table).where(…)
  const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  return {
    db: { insert: mockInsert, update: mockUpdate, select: mockSelect },
    usersTable: {},
  };
});

vi.mock("../lib/discord", () => ({
  getDiscordAuthorizeUrl: vi.fn().mockReturnValue("https://discord.com/oauth2/authorize?state=x"),
  exchangeDiscordCode: vi.fn(),
  fetchDiscordUser: vi.fn(),
  discordAvatarUrl: vi.fn().mockReturnValue(null),
  userIsInGuild: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/site-settings", () => ({
  getSiteSettings: vi.fn().mockResolvedValue({ discordGuildId: null }),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  isAdminDiscordId: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  exchangeDiscordCode,
  fetchDiscordUser,
  userIsInGuild,
} from "../lib/discord";
import { getSiteSettings } from "../lib/site-settings";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import authRouter from "./auth";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a minimal Express app that mounts the auth router with an
 * in-memory session store and seeds session data for testing.
 */
function buildApp(sessionData: Record<string, unknown> = {}): Express {
  const app = express();
  app.use(express.json());

  // In-memory session — no PostgreSQL needed
  app.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: true,
    }),
  );

  // Seed any required session values before the route runs
  app.use((_req, _res, next) => {
    Object.assign(_req.session, sessionData);
    next();
  });

  app.use("/api", authRouter);
  return app;
}

// A minimal Discord user returned by fetchDiscordUser
const DISCORD_USER = { id: "user-discord-id-123", username: "testuser", avatar: null };

// A minimal token response returned by exchangeDiscordCode
const TOKEN_RESPONSE = {
  access_token: "discord-access-token-abc",
  token_type: "Bearer",
  expires_in: 604800,
  refresh_token: "discord-refresh-token",
  scope: "identify guilds",
};

const VALID_STATE = "abc123validstate";

// ── Tests: GET /auth/discord/login ────────────────────────────────────────────

describe("GET /auth/discord/login — redirects to Discord with an OAuth state", () => {
  it("redirects to the Discord authorize URL", async () => {
    const res = await request(buildApp()).get("/api/auth/discord/login");

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize/);
  });
});

// ── Tests: GET /auth/discord/callback ────────────────────────────────────────

describe("GET /auth/discord/callback — state validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exchangeDiscordCode).mockResolvedValue(TOKEN_RESPONSE);
    vi.mocked(fetchDiscordUser).mockResolvedValue(DISCORD_USER);
    vi.mocked(userIsInGuild).mockResolvedValue(true);
    vi.mocked(getSiteSettings).mockResolvedValue({ discordGuildId: null } as Awaited<ReturnType<typeof getSiteSettings>>);
    mockSelectWhere.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([{ id: 1 }]);
    mockUpdateReturning.mockResolvedValue([{ id: 1 }]);
  });

  it("redirects to /?authError=invalid_state when no code is provided", async () => {
    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=invalid_state");
    expect(exchangeDiscordCode).not.toHaveBeenCalled();
  });

  it("redirects to /?authError=invalid_state when no state is provided", async () => {
    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      "/api/auth/discord/callback?code=some-code",
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=invalid_state");
    expect(exchangeDiscordCode).not.toHaveBeenCalled();
  });

  it("redirects to /?authError=invalid_state when state does not match session", async () => {
    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      "/api/auth/discord/callback?code=some-code&state=WRONG_STATE",
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=invalid_state");
    expect(exchangeDiscordCode).not.toHaveBeenCalled();
  });

  it("redirects to /?authError=invalid_state when the session has no stored state (CSRF guard)", async () => {
    // No oauthState in session — simulates a CSRF attempt or stale tab
    const app = buildApp();

    const res = await request(app).get(
      `/api/auth/discord/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=invalid_state");
    expect(exchangeDiscordCode).not.toHaveBeenCalled();
  });
});

describe("GET /auth/discord/callback — missing or invalid OAuth credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([{ id: 1 }]);
  });

  afterEach(() => {
    // Restore env vars cleared in tests
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_CLIENT_SECRET;
    delete process.env.DISCORD_REDIRECT_URI;
  });

  it("redirects to /?authError=oauth_failed (not a 500) when exchangeDiscordCode throws due to missing env vars", async () => {
    // Simulate what happens when DISCORD_CLIENT_ID/SECRET are missing:
    // exchangeDiscordCode throws because getEnv() raises
    vi.mocked(exchangeDiscordCode).mockRejectedValue(
      new Error("DISCORD_CLIENT_ID must be set for Discord OAuth to work."),
    );

    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=oauth_failed");
    // No DB writes should have occurred
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("redirects to /?authError=oauth_failed when Discord rejects the code (invalid/expired)", async () => {
    vi.mocked(exchangeDiscordCode).mockRejectedValue(
      new Error("Discord token exchange failed"),
    );

    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=bad-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=oauth_failed");
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("redirects to /?authError=oauth_failed when fetchDiscordUser throws", async () => {
    vi.mocked(exchangeDiscordCode).mockResolvedValue(TOKEN_RESPONSE);
    vi.mocked(fetchDiscordUser).mockRejectedValue(new Error("Failed to fetch Discord user"));

    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=good-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=oauth_failed");
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("GET /auth/discord/callback — guild membership check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exchangeDiscordCode).mockResolvedValue(TOKEN_RESPONSE);
    vi.mocked(fetchDiscordUser).mockResolvedValue(DISCORD_USER);
    mockSelectWhere.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([{ id: 1 }]);
  });

  it("redirects to /?authError=not_member when guild is configured and user is not in it", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      discordGuildId: "required-guild-id",
    } as Awaited<ReturnType<typeof getSiteSettings>>);
    vi.mocked(userIsInGuild).mockResolvedValue(false);

    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=not_member");
    // Must not create or update any user
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("allows login when guild is configured and user is a member", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      discordGuildId: "required-guild-id",
    } as Awaited<ReturnType<typeof getSiteSettings>>);
    vi.mocked(userIsInGuild).mockResolvedValue(true);

    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("skips the guild check when no discordGuildId is configured", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      discordGuildId: null,
    } as Awaited<ReturnType<typeof getSiteSettings>>);

    const app = buildApp({ oauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/discord/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(userIsInGuild).not.toHaveBeenCalled();
  });

  it("redirects to /?authError=guild_check_failed (not oauth_failed) when the guild API throws a network error", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      discordGuildId: "required-guild-id",
    } as Awaited<ReturnType<typeof getSiteSettings>>);
    vi.mocked(userIsInGuild).mockRejectedValue(
      new Error("Failed to fetch Discord guilds"),
    );

    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?authError=guild_check_failed");
    // Must not create or update any user
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    // Must log the guild API failure distinctly from OAuth failures
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("guild"),
    );
  });
});

describe("GET /auth/discord/callback — new user creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exchangeDiscordCode).mockResolvedValue(TOKEN_RESPONSE);
    vi.mocked(fetchDiscordUser).mockResolvedValue(DISCORD_USER);
    vi.mocked(getSiteSettings).mockResolvedValue({ discordGuildId: null } as Awaited<ReturnType<typeof getSiteSettings>>);
    // No existing user in DB
    mockSelectWhere.mockResolvedValue([]);
    mockInsertReturning.mockResolvedValue([{ id: 42 }]);
  });

  it("redirects to / after successful login for a new user", async () => {
    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("inserts a new user row with discordId, username, and avatarUrl", async () => {
    vi.mocked(fetchDiscordUser).mockResolvedValue({
      id: "discord-999",
      username: "brandnewuser",
      avatar: null,
    });

    const app = buildApp({ oauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/discord/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockInsert = vi.mocked(db.insert);
    expect(mockInsert).toHaveBeenCalledOnce();

    // Retrieve the values() mock and assert it was called with the right fields
    const valuesMock = mockInsert.mock.results[0]!.value.values as ReturnType<typeof vi.fn>;
    const insertArg = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(insertArg).toMatchObject({
      discordId: "discord-999",
      username: "brandnewuser",
    });
    // Update must NOT have been called — this is a new user
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("GET /auth/discord/callback — existing user update", () => {
  const EXISTING_USER = { id: 77 };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exchangeDiscordCode).mockResolvedValue(TOKEN_RESPONSE);
    vi.mocked(fetchDiscordUser).mockResolvedValue(DISCORD_USER);
    vi.mocked(getSiteSettings).mockResolvedValue({ discordGuildId: null } as Awaited<ReturnType<typeof getSiteSettings>>);
    // Existing user found in DB
    mockSelectWhere.mockResolvedValue([EXISTING_USER]);
    mockUpdateReturning.mockResolvedValue([EXISTING_USER]);
  });

  it("redirects to / after successful login for a returning user", async () => {
    const app = buildApp({ oauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/discord/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("updates username and avatarUrl for a returning user", async () => {
    vi.mocked(fetchDiscordUser).mockResolvedValue({
      id: "discord-77",
      username: "updatedname",
      avatar: null,
    });

    const app = buildApp({ oauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/discord/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    expect(mockUpdate).toHaveBeenCalledOnce();

    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArg).toMatchObject({ username: "updatedname" });
    // Insert must NOT have been called — this is an existing user
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ── Tests: POST /auth/logout ──────────────────────────────────────────────────

describe("POST /auth/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 204 on successful logout", async () => {
    const res = await request(buildApp()).post("/api/auth/logout");

    expect(res.status).toBe(204);
  });

  it("clears the session cookie on successful logout", async () => {
    const res = await request(buildApp()).post("/api/auth/logout");

    expect(res.status).toBe(204);
    // The Set-Cookie header must instruct the browser to expire the cookie
    const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
    const cookieHeader = Array.isArray(setCookie)
      ? setCookie.join("; ")
      : (setCookie ?? "");
    expect(cookieHeader).toMatch(/clippnk\.sid/);
    expect(cookieHeader).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it("returns 204 and logs the error when session destroy fails (no 500)", async () => {
    // Build an app whose session.destroy always calls back with an error,
    // simulating an unavailable session store.
    const app = express();
    app.use(express.json());
    app.use(
      session({ secret: "test-secret", resave: false, saveUninitialized: true }),
    );
    // Patch destroy on every request to simulate a store failure
    app.use((req, _res, next) => {
      req.session.destroy = ((cb: (err: unknown) => void) =>
        cb(new Error("session store unavailable"))) as typeof req.session.destroy;
      next();
    });
    app.use("/api", authRouter);

    const res = await request(app).post("/api/auth/logout");

    // Must still respond gracefully — not a 500
    expect(res.status).toBe(204);

    // Error must be logged
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to destroy session",
    );

    // Cookie must still be cleared even when destroy fails
    const setCookie = res.headers["set-cookie"] as string[] | string | undefined;
    const cookieHeader = Array.isArray(setCookie)
      ? setCookie.join("; ")
      : (setCookie ?? "");
    expect(cookieHeader).toMatch(/clippnk\.sid/);
    expect(cookieHeader).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });
});

// ── Tests: GET /auth/me — unauthenticated ─────────────────────────────────────

describe("GET /auth/me — unauthenticated", () => {
  it("returns 401 when no user is present in the session", async () => {
    // buildApp() seeds no session data and the requireAuth mock just calls
    // next() without populating req.currentUser, so the handler sees an
    // unauthenticated request.
    const res = await request(buildApp()).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Not logged in" });
  });
});

// ── Tests: GET /auth/me — deleted user mid-session ───────────────────────────

describe("GET /auth/me — deleted user mid-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 (not 500 or stale data) when the session userId no longer exists in the database", async () => {
    // The DB returns no row for the userId stored in the session,
    // simulating an admin deleting the account while the user's cookie is
    // still active.  loadCurrentUser must leave req.currentUser undefined in
    // that case, and /auth/me must respond with 401.
    mockSelectWhere.mockResolvedValue([]);

    // Build a minimal app that replicates the loadCurrentUser → authRouter
    // pipeline without importing the mocked middlewares/auth module:
    //   1. Seed the session with a stale userId (user no longer in DB).
    //   2. Inline middleware that mirrors loadCurrentUser: queries the DB and
    //      only sets req.currentUser when a row is found.
    //   3. Mount the real auth router.
    const app = express();
    app.use(express.json());
    app.use(
      session({ secret: "test-secret", resave: false, saveUninitialized: true }),
    );

    // Step 1: seed the session with a userId for a now-deleted account.
    app.use((_req, _res, next) => {
      _req.session.userId = 9999;
      next();
    });

    // Step 2: inline loadCurrentUser — db.select().from(…).where(…) is already
    // mocked above to resolve with []; this replicates the real middleware path
    // where the userId is present but the DB row is gone.
    app.use(async (_req, _res, next) => {
      const [user] = await mockSelectWhere();
      if (user) {
        // Would set req.currentUser = user, but nothing is returned here.
        (_req as Express.Request).currentUser = user as Express.Request["currentUser"];
      }
      next();
    });

    app.use("/api", authRouter);

    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "Not logged in" });
  });
});
