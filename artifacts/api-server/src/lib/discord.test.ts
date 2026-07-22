/**
 * Unit tests for lib/discord.ts — checkDiscordBotToken / checkDiscordBotTokenUncached
 *
 * Confirms that a set-but-invalid Discord bot token produces a clear
 * false result (and a warning log) rather than silently passing through.
 * Confirms the request resolves false (not rejected) when it exceeds the timeout.
 * No network calls are made; global fetch is stubbed per test.
 *
 * Most tests exercise checkDiscordBotTokenUncached to bypass the in-memory
 * cache and keep tests independent of each other.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { checkDiscordBotToken, checkDiscordBotTokenUncached } from "./discord";

// Silence pino logger output during tests
vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function mockFetch(status: number, ok = status >= 200 && status < 300): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ status, ok }),
  );
}

function mockFetchNetworkError(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network error")),
  );
}

function mockFetchAbortError(): void {
  const err = new DOMException("The operation was aborted.", "AbortError");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(err),
  );
}

describe("checkDiscordBotTokenUncached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns true when Discord accepts the token (200 OK)", async () => {
    mockFetch(200);
    const result = await checkDiscordBotTokenUncached("valid-bot-token");
    expect(result).toBe(true);
  });

  it("returns false when Discord rejects with 401 (revoked / wrong secret)", async () => {
    mockFetch(401, false);
    const result = await checkDiscordBotTokenUncached("revoked-token");
    expect(result).toBe(false);
  });

  it("returns false when Discord rejects with 403 (insufficient permissions)", async () => {
    mockFetch(403, false);
    const result = await checkDiscordBotTokenUncached("no-permission-token");
    expect(result).toBe(false);
  });

  it("returns false on unexpected 5xx response from Discord", async () => {
    mockFetch(500, false);
    const result = await checkDiscordBotTokenUncached("some-token");
    expect(result).toBe(false);
  });

  it("returns false when the network request throws", async () => {
    mockFetchNetworkError();
    const result = await checkDiscordBotTokenUncached("some-token");
    expect(result).toBe(false);
  });

  it("returns false (does not reject) when the request exceeds the timeout", async () => {
    // Simulate fetch being aborted by the internal AbortController
    mockFetchAbortError();
    const result = await checkDiscordBotTokenUncached("slow-token");
    expect(result).toBe(false);
  });

  it("logs a warning when the token is rejected by Discord", async () => {
    const { logger } = await import("./logger");
    mockFetch(401, false);

    await checkDiscordBotTokenUncached("bad-token");

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("logs a warning when the network request fails", async () => {
    const { logger } = await import("./logger");
    mockFetchNetworkError();

    await checkDiscordBotTokenUncached("bad-token");

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("logs a warning when the request times out", async () => {
    const { logger } = await import("./logger");
    mockFetchAbortError();

    await checkDiscordBotTokenUncached("slow-token");

    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("sends the Authorization header as 'Bot <token>'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await checkDiscordBotTokenUncached("my-bot-token");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bot my-bot-token",
    );
  });

  it("passes an AbortSignal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await checkDiscordBotTokenUncached("my-bot-token");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("checkDiscordBotToken (caching)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("returns a cached result on repeated calls with the same token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true });
    vi.stubGlobal("fetch", fetchMock);

    // Use a unique token so we don't collide with other test runs
    const token = `cache-test-token-${Date.now()}`;
    const r1 = await checkDiscordBotToken(token);
    const r2 = await checkDiscordBotToken(token);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // fetch should only have been called once — second call served from cache
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bypasses the cache and hits Discord again when the token value changes", async () => {
    // First call: token A is valid
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, ok: true }) // token A → valid
      .mockResolvedValueOnce({ status: 401, ok: false }); // token B → invalid
    vi.stubGlobal("fetch", fetchMock);

    const ts = Date.now();
    const tokenA = `token-a-${ts}`;
    const tokenB = `token-b-${ts}`;

    const r1 = await checkDiscordBotToken(tokenA);
    expect(r1).toBe(true);

    // Switching to a different token must not serve the cached result for tokenA
    const r2 = await checkDiscordBotToken(tokenB);
    expect(r2).toBe(false);

    // fetch must have been called twice — once per distinct token
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
