/**
 * Unit tests for lib/github.ts
 *
 * Tests `exchangeGithubCode`, `fetchGithubUser`, and `checkHasStarred` in
 * isolation by stubbing global fetch.  No network calls are made; no database
 * is required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  exchangeGithubCode,
  fetchGithubUser,
  checkHasStarred,
  GithubTokenInvalidError,
  GithubRateLimitError,
} from "./github";

// Silence pino logger output during tests
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function mockFetchResponse(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
    }),
  );
}

describe("checkHasStarred", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when GitHub responds with 204 (user has starred)", async () => {
    mockFetchResponse(204);
    const result = await checkHasStarred("valid-token");
    expect(result).toBe(true);
  });

  it("returns false when GitHub responds with 404 (user has not starred)", async () => {
    mockFetchResponse(404);
    const result = await checkHasStarred("valid-token");
    expect(result).toBe(false);
  });

  it("throws GithubTokenInvalidError when GitHub responds with 401 (revoked/expired token)", async () => {
    mockFetchResponse(401);
    await expect(checkHasStarred("revoked-token")).rejects.toThrow(
      GithubTokenInvalidError,
    );
  });

  it("thrown error on 401 is an instance of GithubTokenInvalidError", async () => {
    mockFetchResponse(401);
    try {
      await checkHasStarred("revoked-token");
      expect.fail("Expected GithubTokenInvalidError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubTokenInvalidError);
      expect((err as GithubTokenInvalidError).name).toBe(
        "GithubTokenInvalidError",
      );
    }
  });

  it("throws GithubRateLimitError when GitHub responds with 429 (rate limited)", async () => {
    mockFetchResponse(429);
    await expect(checkHasStarred("some-token")).rejects.toThrow(
      GithubRateLimitError,
    );
  });

  it("thrown error on 429 is an instance of GithubRateLimitError", async () => {
    mockFetchResponse(429);
    try {
      await checkHasStarred("some-token");
      expect.fail("Expected GithubRateLimitError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GithubRateLimitError);
      expect((err as GithubRateLimitError).name).toBe("GithubRateLimitError");
    }
  });

  it("throws a generic Error for unexpected non-401/404/204 status codes", async () => {
    mockFetchResponse(500);
    await expect(checkHasStarred("some-token")).rejects.toThrow(
      "Star check failed",
    );
  });

  it("sends the Authorization header with the provided token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await checkHasStarred("my-secret-token");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer my-secret-token",
    );
  });

  it("propagates a fetch rejection when GitHub is unreachable (network error)", async () => {
    const networkError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    await expect(checkHasStarred("any-token")).rejects.toThrow("fetch failed");
  });

  it("propagated network error is the original Error instance", async () => {
    const networkError = new TypeError("Network request failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    try {
      await checkHasStarred("any-token");
      expect.fail("Expected the network error to be thrown");
    } catch (err) {
      expect(err).toBe(networkError);
    }
  });
});

// ── exchangeGithubCode ────────────────────────────────────────────────────────

describe("exchangeGithubCode", () => {
  beforeEach(() => {
    // Provide the env vars that getEnv() requires.
    process.env.GITHUB_CLIENT_ID = "test-client-id";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
    process.env.GITHUB_REDIRECT_URI = "http://localhost/auth/github/callback";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_REDIRECT_URI;
  });

  it("propagates a fetch rejection when GitHub's token endpoint is unreachable", async () => {
    const networkError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    await expect(exchangeGithubCode("some-code")).rejects.toThrow("fetch failed");
  });

  it("propagated network error from exchangeGithubCode is the original Error instance", async () => {
    const networkError = new TypeError("Network request failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    try {
      await exchangeGithubCode("some-code");
      expect.fail("Expected the network error to be thrown");
    } catch (err) {
      expect(err).toBe(networkError);
    }
  });

  it("throws when GitHub responds with a non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }),
    );
    await expect(exchangeGithubCode("some-code")).rejects.toThrow(
      "GitHub token exchange failed",
    );
  });

  it("throws when GitHub returns an error field in the JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ error: "bad_verification_code" }),
      }),
    );
    await expect(exchangeGithubCode("bad-code")).rejects.toThrow(
      "GitHub OAuth error: bad_verification_code",
    );
  });

  it("returns the token response on success", async () => {
    const payload = {
      access_token: "gho_abc123",
      token_type: "bearer",
      scope: "read:user",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      }),
    );
    const result = await exchangeGithubCode("valid-code");
    expect(result.access_token).toBe("gho_abc123");
  });
});

// ── fetchGithubUser ───────────────────────────────────────────────────────────

describe("fetchGithubUser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propagates a fetch rejection when the GitHub user API is unreachable", async () => {
    const networkError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    await expect(fetchGithubUser("some-token")).rejects.toThrow("fetch failed");
  });

  it("propagated network error from fetchGithubUser is the original Error instance", async () => {
    const networkError = new TypeError("Network request failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    try {
      await fetchGithubUser("some-token");
      expect.fail("Expected the network error to be thrown");
    } catch (err) {
      expect(err).toBe(networkError);
    }
  });

  it("throws when GitHub user API responds with a non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(fetchGithubUser("bad-token")).rejects.toThrow(
      "Failed to fetch GitHub user",
    );
  });

  it("returns the user object on success", async () => {
    const user = { id: 12345, login: "octocat" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => user,
      }),
    );
    const result = await fetchGithubUser("valid-token");
    expect(result.id).toBe(12345);
    expect(result.login).toBe("octocat");
  });
});
