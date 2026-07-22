/**
 * Integration tests for the GitHub OAuth routes.
 *
 * The database, GitHub API, and session store are all mocked; no external
 * connections are made.
 *
 * Covers:
 *   POST /auth/github/check-star  — revoked/expired token handling
 *   GET  /auth/github/callback    — state validation, already-linked guard,
 *                                   and successful link (with / without star)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import request from "supertest";

// ── Hoisted mocks (must come before vi.mock calls) ────────────────────────────

/**
 * `mockSelectWhere` is the terminal `.where()` call in the
 * `db.select().from(…).where(…)` chain used by the callback handler to check
 * for already-linked GitHub accounts. Hoisting lets us control its resolved
 * value per-test without re-creating the entire mock factory.
 *
 * `mockUpdateWhere` is the terminal `.where()` call in the
 * `db.update(…).set(…).where(…)` chain. Hoisting lets us simulate DB errors
 * in the disconnect and other update paths per-test.
 */
const { mockSelectWhere, mockUpdateWhere } = vi.hoisted(() => {
  const mockSelectWhere = vi.fn().mockResolvedValue([]);
  const mockUpdateWhere = vi.fn().mockResolvedValue([]);
  return { mockSelectWhere, mockUpdateWhere };
});

// ── Module mocks (hoisted before any imports) ─────────────────────────────────

vi.mock("@workspace/db", () => {
  // update chain: db.update(table).set({…}).where(…)
  const mockSet = vi.fn().mockReturnThis();
  const mockUpdate = vi.fn(() => ({ set: mockSet }));
  mockSet.mockReturnValue({ where: mockUpdateWhere });

  // select chain: db.select().from(table).where(…)
  const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  return {
    db: { update: mockUpdate, select: mockSelect },
    usersTable: {},
  };
});

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    // currentUser is injected per-test via req.currentUser assignment below;
    // this stub simply calls next() so the route handler runs.
    next();
  },
}));

vi.mock("../lib/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/github")>();
  return {
    ...actual,
    isGithubConfigured: vi.fn().mockReturnValue(true),
    getGithubAuthorizeUrl: vi.fn().mockReturnValue("https://github.com/login/oauth/authorize?state=x"),
    exchangeGithubCode: vi.fn(),
    fetchGithubUser: vi.fn(),
    checkHasStarred: vi.fn(),
    STAR_BONUS_BYTES: actual.STAR_BONUS_BYTES,
  };
});

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { db } from "@workspace/db";
import {
  checkHasStarred,
  exchangeGithubCode,
  fetchGithubUser,
  GithubTokenInvalidError,
} from "../lib/github";
import githubRouter from "./github";
import type { User } from "@workspace/db";

// ── Helpers ───────────────────────────────────────────────────────────────────

type PartialUser = Partial<User> & Pick<User, "id">;

/**
 * Builds a minimal Express app that mounts the GitHub router with an
 * in-memory session store and a middleware that injects `currentUser`.
 */
function buildApp(currentUser: PartialUser, sessionData: Record<string, unknown> = {}): Express {
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

  // Inject the fake user and any seed session values
  app.use((req, _res, next) => {
    req.currentUser = currentUser as User;
    Object.assign(req.session, sessionData);
    next();
  });

  app.use("/api", githubRouter);
  return app;
}

/** A fully-linked user whose token has since been revoked on GitHub. */
function linkedUserWithRevokedToken(): PartialUser {
  return {
    id: 42,
    discordId: "discord-123",
    username: "tester",
    avatarUrl: null,
    usedStorageBytes: 0,
    githubId: "gh-789",
    githubUsername: "octocat",
    githubStarBonusGranted: false,
    githubAccessToken: "revoked-token-abc",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** A user who has not yet linked a GitHub account. */
function unlinkedUser(): PartialUser {
  return {
    id: 99,
    discordId: "discord-999",
    username: "newuser",
    avatarUrl: null,
    usedStorageBytes: 0,
    githubId: null,
    githubUsername: null,
    githubStarBonusGranted: false,
    githubAccessToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ── Tests: POST /auth/github/check-star ───────────────────────────────────────

describe("POST /auth/github/check-star — revoked / expired token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockResolvedValue([]);
  });

  it("returns 401 with { error: 'token_invalid' } when the stored DB token is revoked", async () => {
    vi.mocked(checkHasStarred).mockRejectedValue(new GithubTokenInvalidError());

    const user = linkedUserWithRevokedToken();
    const app = buildApp(user);

    const res = await request(app).post("/api/auth/github/check-star");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "token_invalid" });
  });

  it("clears githubAccessToken in the DB when the token is revoked", async () => {
    vi.mocked(checkHasStarred).mockRejectedValue(new GithubTokenInvalidError());

    const user = linkedUserWithRevokedToken();
    const app = buildApp(user);

    await request(app).post("/api/auth/github/check-star");

    // db.update(...).set({ githubAccessToken: null }).where(...)
    const mockUpdate = vi.mocked(db.update);
    expect(mockUpdate).toHaveBeenCalledOnce();

    // Retrieve the set() mock and assert it was called with null
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    expect(setMock).toHaveBeenCalledWith({ githubAccessToken: null });
  });

  it("returns 200 with starred=true when the token is still valid and the repo is starred", async () => {
    vi.mocked(checkHasStarred).mockResolvedValue(true);

    // Use a user whose bonus is already granted (fast-path skipped because we
    // want to test the live-check path; set bonusGranted=false initially).
    const user: PartialUser = {
      ...linkedUserWithRevokedToken(),
      githubStarBonusGranted: false,
    };
    const app = buildApp(user);

    const res = await request(app).post("/api/auth/github/check-star");

    expect(res.status).toBe(200);
    expect(res.body.starred).toBe(true);
    expect(res.body.githubUsername).toBe("octocat");
  });

  it("returns 200 with starred=false when the token is valid but the repo is not starred", async () => {
    vi.mocked(checkHasStarred).mockResolvedValue(false);

    const user: PartialUser = {
      ...linkedUserWithRevokedToken(),
      githubStarBonusGranted: false,
    };
    const app = buildApp(user);

    const res = await request(app).post("/api/auth/github/check-star");

    expect(res.status).toBe(200);
    expect(res.body.starred).toBe(false);
    expect(res.body.bonusGranted).toBe(false);
  });

  it("fast-paths with bonusGranted=true when the bonus is already recorded in the DB", async () => {
    const user: PartialUser = {
      ...linkedUserWithRevokedToken(),
      githubStarBonusGranted: true,
    };
    const app = buildApp(user);

    const res = await request(app).post("/api/auth/github/check-star");

    expect(res.status).toBe(200);
    expect(res.body.bonusGranted).toBe(true);
    // GitHub should NOT have been called — bonus is already known
    expect(checkHasStarred).not.toHaveBeenCalled();
  });

  it("returns 400 when no GitHub account is linked", async () => {
    const user: PartialUser = {
      id: 1,
      discordId: "d1",
      username: "anon",
      avatarUrl: null,
      usedStorageBytes: 0,
      githubId: null,
      githubUsername: null,
      githubStarBonusGranted: false,
      githubAccessToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const app = buildApp(user);

    const res = await request(app).post("/api/auth/github/check-star");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No GitHub account linked");
  });

  it("uses the session-cached token instead of the DB token when both are present", async () => {
    vi.mocked(checkHasStarred).mockResolvedValue(false);

    const user = linkedUserWithRevokedToken(); // has githubAccessToken in DB
    // Seed session with a different token — this one should be preferred
    const app = buildApp(user, { githubAccessToken: "session-token-xyz" });

    await request(app).post("/api/auth/github/check-star");

    expect(vi.mocked(checkHasStarred)).toHaveBeenCalledWith("session-token-xyz");
  });
});

// ── Tests: GET /auth/github/callback ─────────────────────────────────────────

describe("GET /auth/github/callback — OAuth state validation, duplicate-link guard, and successful link", () => {
  const VALID_STATE = "abc123validstate";

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing GitHub link in the DB
    mockSelectWhere.mockResolvedValue([]);
    // Default GitHub API stubs — override per test as needed
    vi.mocked(exchangeGithubCode).mockResolvedValue({ access_token: "gh-token-xyz" } as Awaited<ReturnType<typeof exchangeGithubCode>>);
    vi.mocked(fetchGithubUser).mockResolvedValue({ id: 1001, login: "octocat" } as Awaited<ReturnType<typeof fetchGithubUser>>);
    vi.mocked(checkHasStarred).mockResolvedValue(false);
  });

  // ── State validation ────────────────────────────────────────────────────────

  it("redirects to /?githubError=invalid_state when no code is provided", async () => {
    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=invalid_state");
  });

  it("redirects to /?githubError=invalid_state when no state is provided", async () => {
    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      "/api/auth/github/callback?code=some-code",
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=invalid_state");
  });

  it("redirects to /?githubError=invalid_state when the state does not match the session", async () => {
    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      "/api/auth/github/callback?code=some-code&state=WRONG_STATE",
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=invalid_state");
    // GitHub token exchange must NOT have been attempted
    expect(exchangeGithubCode).not.toHaveBeenCalled();
  });

  it("redirects to /?githubError=invalid_state when the session has no stored state", async () => {
    // No githubOauthState in session — simulates a CSRF attempt or stale tab
    const app = buildApp(unlinkedUser());

    const res = await request(app).get(
      `/api/auth/github/callback?code=some-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=invalid_state");
    expect(exchangeGithubCode).not.toHaveBeenCalled();
  });

  // ── Already-linked guard ────────────────────────────────────────────────────

  it("redirects to /?githubError=already_linked when the GitHub account is linked to a different user", async () => {
    const currentUser = unlinkedUser(); // id: 99
    // DB returns a *different* user who already owns this GitHub account
    const otherUser = { id: 777 };
    mockSelectWhere.mockResolvedValue([otherUser]);

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=already_linked");
    // DB update must NOT have been called — no data should have been written
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does NOT redirect with already_linked when the same user re-links their own account", async () => {
    const currentUser = unlinkedUser(); // id: 99
    // DB returns the *same* user — safe to overwrite/update
    mockSelectWhere.mockResolvedValue([{ id: currentUser.id }]);

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubLinked=1");
  });

  // ── Successful link ─────────────────────────────────────────────────────────

  it("redirects to /?githubLinked=1 after a successful link", async () => {
    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubLinked=1");
  });

  it("persists githubId, githubUsername, and githubAccessToken to the DB on success", async () => {
    vi.mocked(fetchGithubUser).mockResolvedValue({ id: 5555, login: "newoctocat" } as Awaited<ReturnType<typeof fetchGithubUser>>);
    vi.mocked(exchangeGithubCode).mockResolvedValue({ access_token: "fresh-token" } as Awaited<ReturnType<typeof exchangeGithubCode>>);

    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    expect(mockUpdate).toHaveBeenCalledOnce();

    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArg).toMatchObject({
      githubId: "5555",
      githubUsername: "newoctocat",
      githubAccessToken: "fresh-token",
    });
  });

  it("also grants the star bonus in the DB update when the user has starred the repo", async () => {
    vi.mocked(checkHasStarred).mockResolvedValue(true);

    const user: PartialUser = { ...unlinkedUser(), githubStarBonusGranted: false };
    const app = buildApp(user, { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArg).toMatchObject({ githubStarBonusGranted: true });
  });

  it("does NOT include githubStarBonusGranted in the DB update when the user has not starred", async () => {
    vi.mocked(checkHasStarred).mockResolvedValue(false);

    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArg).not.toHaveProperty("githubStarBonusGranted");
  });

  it("does NOT grant the bonus again when it is already recorded in the DB", async () => {
    vi.mocked(checkHasStarred).mockResolvedValue(true);

    // Bonus already granted — the route should skip the grant
    const user: PartialUser = { ...unlinkedUser(), githubStarBonusGranted: true };
    const app = buildApp(user, { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArg).not.toHaveProperty("githubStarBonusGranted");
  });

  it("redirects to /?githubError=oauth_failed when the GitHub token exchange throws", async () => {
    vi.mocked(exchangeGithubCode).mockRejectedValue(new Error("network error"));

    const app = buildApp(unlinkedUser(), { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?code=bad-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=oauth_failed");
    expect(db.update).not.toHaveBeenCalled();
  });
});

// ── Tests: GET /auth/github/callback — re-link flow ──────────────────────────
//
// These tests focus specifically on the case where a user who *already* has a
// linked GitHub account goes through the OAuth callback again — either to
// refresh their token (same account) or with a GitHub identity that belongs to
// someone else (different account).

describe("GET /auth/github/callback — re-link flow", () => {
  const VALID_STATE = "relink-state-xyz";

  /** A user who already has a GitHub account linked and the star bonus recorded. */
  function alreadyLinkedUser(): PartialUser {
    return {
      id: 55,
      discordId: "discord-55",
      username: "alreadylinked",
      avatarUrl: null,
      usedStorageBytes: 0,
      githubId: "gh-1001",
      githubUsername: "original-octocat",
      githubStarBonusGranted: true,
      githubAccessToken: "old-token",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no conflict in the DB
    mockSelectWhere.mockResolvedValue([]);
    vi.mocked(exchangeGithubCode).mockResolvedValue({ access_token: "new-token" } as Awaited<ReturnType<typeof exchangeGithubCode>>);
    vi.mocked(fetchGithubUser).mockResolvedValue({ id: 1001, login: "original-octocat" } as Awaited<ReturnType<typeof fetchGithubUser>>);
    vi.mocked(checkHasStarred).mockResolvedValue(false);
  });

  it("re-linking the same GitHub account succeeds and redirects to /?githubLinked=1", async () => {
    // DB reports the same user owns this GitHub account — not a conflict
    const currentUser = alreadyLinkedUser();
    mockSelectWhere.mockResolvedValue([{ id: currentUser.id }]);

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubLinked=1");
  });

  it("re-linking the same GitHub account updates githubId, githubUsername, and githubAccessToken", async () => {
    const currentUser = alreadyLinkedUser();
    mockSelectWhere.mockResolvedValue([{ id: currentUser.id }]);

    vi.mocked(fetchGithubUser).mockResolvedValue({ id: 1001, login: "original-octocat" } as Awaited<ReturnType<typeof fetchGithubUser>>);
    vi.mocked(exchangeGithubCode).mockResolvedValue({ access_token: "refreshed-token" } as Awaited<ReturnType<typeof exchangeGithubCode>>);

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    expect(mockUpdate).toHaveBeenCalledOnce();

    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(setArg).toMatchObject({
      githubId: "1001",
      githubUsername: "original-octocat",
      githubAccessToken: "refreshed-token",
    });
  });

  it("re-linking the same GitHub account does NOT overwrite githubStarBonusGranted when it is already true", async () => {
    // The user has the bonus. Even if they've starred the repo, re-linking
    // the same account must not touch the already-granted field.
    const currentUser = alreadyLinkedUser(); // githubStarBonusGranted: true
    mockSelectWhere.mockResolvedValue([{ id: currentUser.id }]);
    vi.mocked(checkHasStarred).mockResolvedValue(true); // still starred

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    const mockUpdate = vi.mocked(db.update);
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>;

    // githubStarBonusGranted must NOT be present — the handler only includes it
    // when granting for the first time (shouldGrant = starred && !alreadyGranted).
    expect(setArg).not.toHaveProperty("githubStarBonusGranted");
  });

  it("re-linking to a different GitHub account that belongs to another user is blocked with /?githubError=already_linked", async () => {
    const currentUser = alreadyLinkedUser(); // id: 55
    // A different user (id: 777) already owns the GitHub account the callback returns
    const differentUser = { id: 777 };
    mockSelectWhere.mockResolvedValue([differentUser]);

    vi.mocked(fetchGithubUser).mockResolvedValue({ id: 9999, login: "someone-else" } as Awaited<ReturnType<typeof fetchGithubUser>>);

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    const res = await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/?githubError=already_linked");
  });

  it("re-linking to a different GitHub account owned by another user does not write any DB changes", async () => {
    const currentUser = alreadyLinkedUser(); // id: 55
    mockSelectWhere.mockResolvedValue([{ id: 777 }]);

    vi.mocked(fetchGithubUser).mockResolvedValue({ id: 9999, login: "someone-else" } as Awaited<ReturnType<typeof fetchGithubUser>>);

    const app = buildApp(currentUser, { githubOauthState: VALID_STATE });

    await request(app).get(
      `/api/auth/github/callback?code=auth-code&state=${VALID_STATE}`,
    );

    // The route must bail out before any DB write
    expect(db.update).not.toHaveBeenCalled();
  });
});

// ── Tests: DELETE /auth/github/disconnect ─────────────────────────────────────

describe("DELETE /auth/github/disconnect — unlink GitHub account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectWhere.mockResolvedValue([]);
    mockUpdateWhere.mockResolvedValue([]);
  });

  it("returns HTTP 204 on a successful disconnect", async () => {
    const app = buildApp(linkedUserWithRevokedToken());

    const res = await request(app).delete("/api/auth/github/disconnect");

    expect(res.status).toBe(204);
  });

  it("sets githubId, githubUsername, and githubAccessToken to null in the DB for the correct user", async () => {
    const user = linkedUserWithRevokedToken(); // id: 42
    const app = buildApp(user);

    await request(app).delete("/api/auth/github/disconnect");

    const mockUpdate = vi.mocked(db.update);
    expect(mockUpdate).toHaveBeenCalledOnce();

    // Confirm the update targets the correct table
    expect(mockUpdate).toHaveBeenCalledWith(expect.anything());

    // Confirm .set() was called with all three fields nulled out
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    expect(setMock).toHaveBeenCalledWith({
      githubId: null,
      githubUsername: null,
      githubAccessToken: null,
    });
  });

  it("scopes the DB update to the authenticated user's id", async () => {
    const { eq } = await import("drizzle-orm");
    const { usersTable } = await import("@workspace/db");

    const user = linkedUserWithRevokedToken(); // id: 42
    const app = buildApp(user);

    await request(app).delete("/api/auth/github/disconnect");

    const mockUpdate = vi.mocked(db.update);
    const setMock = mockUpdate.mock.results[0]!.value.set as ReturnType<typeof vi.fn>;
    const whereMock = setMock.mock.results[0]!.value.where as ReturnType<typeof vi.fn>;

    // where() must have been called with the eq predicate for the correct user id
    expect(whereMock).toHaveBeenCalledWith(eq(usersTable.id, user.id));
  });

  it("returns HTTP 500 and { error: 'disconnect_failed' } when the DB update throws", async () => {
    mockUpdateWhere.mockRejectedValue(new Error("DB connection lost"));

    const app = buildApp(linkedUserWithRevokedToken());

    const res = await request(app).delete("/api/auth/github/disconnect");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "disconnect_failed" });
  });

  it("does NOT clear session.githubAccessToken when the DB update throws", async () => {
    mockUpdateWhere.mockRejectedValue(new Error("DB connection lost"));

    // Build an app with a session-inspect route so we can verify session state.
    const app = express();
    app.use(express.json());
    app.use(
      session({
        secret: "test-secret",
        resave: false,
        saveUninitialized: true,
      }),
    );

    // Inject the fake user and seed the session with a stored GitHub token.
    app.use((req, _res, next) => {
      req.currentUser = linkedUserWithRevokedToken() as User;
      if (!(req.session as unknown as Record<string, unknown>)["_seeded"]) {
        (req.session as unknown as Record<string, unknown>)["githubAccessToken"] = "cached-token";
        (req.session as unknown as Record<string, unknown>)["_seeded"] = true;
      }
      next();
    });

    app.use("/api", githubRouter);

    app.get("/session-inspect", (req, res) => {
      res.json({ githubAccessToken: req.session.githubAccessToken ?? null });
    });

    const agent = request.agent(app);

    // Confirm the token is present before the failed disconnect.
    const before = await agent.get("/session-inspect");
    expect(before.body.githubAccessToken).toBe("cached-token");

    // Attempt disconnect — DB throws, so it should fail.
    const disconnectRes = await agent.delete("/api/auth/github/disconnect");
    expect(disconnectRes.status).toBe(500);

    // The session token must still be present — the DB and session stay in sync.
    const after = await agent.get("/session-inspect");
    expect(after.body.githubAccessToken).toBe("cached-token");
  });

  it("clears session.githubAccessToken after disconnect", async () => {
    // Build an app with an extra /check-session route so we can inspect
    // session state in a follow-up request from the same agent (same cookie).
    const app = express();
    app.use(express.json());
    app.use(
      session({
        secret: "test-secret",
        resave: false,
        saveUninitialized: true,
      }),
    );

    // Inject the fake user and seed the session with a stored GitHub token
    app.use((req, _res, next) => {
      req.currentUser = linkedUserWithRevokedToken() as User;
      if (!(req.session as unknown as Record<string, unknown>)["_seeded"]) {
        (req.session as unknown as Record<string, unknown>)["githubAccessToken"] = "cached-token";
        (req.session as unknown as Record<string, unknown>)["_seeded"] = true;
      }
      next();
    });

    app.use("/api", githubRouter);

    // Expose a route that returns the current session's githubAccessToken value
    app.get("/session-inspect", (req, res) => {
      res.json({ githubAccessToken: req.session.githubAccessToken ?? null });
    });

    const agent = request.agent(app);

    // Confirm the token is present before disconnect
    const before = await agent.get("/session-inspect");
    expect(before.body.githubAccessToken).toBe("cached-token");

    // Disconnect
    await agent.delete("/api/auth/github/disconnect");

    // Confirm the token has been cleared from the session
    const after = await agent.get("/session-inspect");
    expect(after.body.githubAccessToken).toBeNull();
  });
});
