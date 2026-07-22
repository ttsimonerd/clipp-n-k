/**
 * Integration tests for the clip upload/trim pipeline (routes/clips.ts).
 *
 * Database, storage driver, ffmpeg, and site-settings are all mocked so no
 * external connections or real ffmpeg invocations are needed here. The real
 * ffmpeg binary is exercised in lib/ffmpeg.test.ts instead.
 *
 * Covers:
 *   POST /clips  — MIME-type rejection, per-file size rejection,
 *                  user quota rejection, successful upload + DB insert,
 *                  async pipeline marks clip ready + updates storage accounting
 *                  (via SUM query, not incremental arithmetic),
 *                  async pipeline marks clip failed when processClip throws,
 *                  partial storage writes cleaned up when thumbnail upload fails,
 *                  storage left untouched when processClip fails before any upload
 *   POST /clips/:id/trim — 202 immediately, endSeconds validation,
 *                          trim marks clip ready + updates storage accounting
 *                          (via SUM query),
 *                          trim marks clip failed when processClip throws,
 *                          partial storage writes cleaned up on trim failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import request from "supertest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
//
// All mock functions are hoisted so they can be referenced inside vi.mock()
// factory bodies (which are themselves hoisted to the top of the module by
// the Vitest transformer before any import runs).

const {
  mockInsertReturning,
  mockUpdateSet,       // called with each .set({…}) argument so tests can assert on it
  mockUpdateReturning, // called when .returning() is invoked (trim route)
  mockSelectWhere,
  mockDeleteWhere,
  mockProcessClip,
  mockStoragePutFile,
  mockStorageGetLocalPath,
  mockStorageDeleteFile,
} = vi.hoisted(() => ({
  mockInsertReturning: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockDeleteWhere: vi.fn().mockResolvedValue([]),
  mockProcessClip: vi.fn(),
  mockStoragePutFile: vi.fn().mockResolvedValue(undefined),
  mockStorageGetLocalPath: vi.fn(),
  mockStorageDeleteFile: vi.fn().mockResolvedValue(undefined),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  // insert chain: db.insert(table).values({…}).returning()
  const mockValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockValues }));

  // update chain:
  //   Awaitable form: db.update(t).set({…}).where(…)           → Promise<[]>
  //   Returning form: db.update(t).set({…}).where(…).returning() → Promise<[row]>
  //
  // mockUpdateSet records every .set({…}) call so tests can inspect what status
  // values were written. The chain must produce a real Promise (not a hand-rolled
  // thenable) to ensure the microtask queue is properly advanced when the route
  // awaits it.
  const mockUpdate = vi.fn(() => ({
    set: (data: Record<string, unknown>) => {
      mockUpdateSet(data);
      return {
        where: (..._args: unknown[]) => {
          const p = Promise.resolve([] as unknown[]);
          // Attach .returning() so the trim route can call .where().returning()
          return Object.assign(p, {
            returning: () => {
              mockUpdateReturning();
              return Promise.resolve(mockUpdateReturning.mock.results.slice(-1)[0]?.value ?? []);
            },
          });
        },
      };
    },
  }));

  // select chain: db.select().from(table).where(…)
  const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));

  // delete chain: db.delete(table).where(…)
  const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));

  return {
    db: { insert: mockInsert, update: mockUpdate, select: mockSelect, delete: mockDelete },
    clipsTable: {},
    usersTable: {},
  };
});

vi.mock("../lib/site-settings", () => ({
  getSiteSettings: vi.fn(),
}));

vi.mock("../lib/storage", () => ({
  getStorageDriver: vi.fn(() => ({
    putFile: mockStoragePutFile,
    getLocalPath: mockStorageGetLocalPath,
    deleteFile: mockStorageDeleteFile,
    getPublicUrl: vi.fn((key: string) => `/static/${key}`),
  })),
}));

vi.mock("../lib/ffmpeg", () => ({
  processClip: mockProcessClip,
  probeVideo: vi.fn().mockResolvedValue({ durationSeconds: 4, width: 320, height: 240 }),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-slug-01"),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { getSiteSettings } from "../lib/site-settings";
import { db, type User } from "@workspace/db";
import clipsRouter from "./clips";

// ── Constants & helpers ───────────────────────────────────────────────────────

const ONE_MB = 1_048_576;
const ONE_GB = 1_073_741_824;

/** Default site settings used unless overridden in a specific test. */
const DEFAULT_SETTINGS = {
  id: 1,
  allowedMimeTypes: ["video/mp4", "video/webm"],
  maxUploadBytes: 500 * ONE_MB,       // 500 MB per file
  maxUserStorageBytes: 5 * ONE_GB,    // 5 GB per user
  maxClipDurationSeconds: null,
  defaultVisibility: "private" as const,
  discordGuildId: null,
  brandingTitle: "Test",
  brandingLogoUrl: null,
  brandingPrimaryColor: "#5865F2",
  updatedAt: new Date(),
};

/** Minimal user object injected via middleware. */
const DEFAULT_USER = {
  id: 42,
  usedStorageBytes: 0,
  githubStarBonusGranted: false,
};

/** A minimal clip row that the DB insert mock returns. */
const INSERTED_CLIP = {
  id: 1,
  ownerId: DEFAULT_USER.id,
  slug: "test-slug-01",
  title: "test.mp4",
  originalFilename: "test.mp4",
  mimeType: "video/mp4",
  sizeBytes: ONE_MB,
  storageKey: "clips/test-slug-01.mp4",
  thumbnailKey: "clips/test-slug-01-thumb.jpg",
  durationSeconds: null,
  width: null,
  height: null,
  visibility: "private",
  status: "processing",
  failureReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Build an Express app that mounts the clips router with `currentUser` injected. */
function buildApp(currentUser = DEFAULT_USER): Express {
  const app = express();
  app.use(express.json());

  // Inject the authenticated user before any route handler runs.
  // requireAuth is mocked to just call next(), so we only need currentUser set.
  app.use((req, _res, next) => {
    req.currentUser = currentUser as User;
    next();
  });

  app.use("/api", clipsRouter);
  return app;
}

/**
 * Wait for fire-and-forget async work triggered after the HTTP response.
 *
 * Uses a real setTimeout so all microtask queues (including Promise chains
 * inside the pipeline) drain before we inspect mock call records.
 */
async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();

  // Create a per-test temp dir so processClip can write real output files
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clippnk-clips-test-"));

  // Default settings
  vi.mocked(getSiteSettings).mockResolvedValue(
    DEFAULT_SETTINGS as Awaited<ReturnType<typeof getSiteSettings>>,
  );

  // Default DB responses
  mockInsertReturning.mockResolvedValue([INSERTED_CLIP]);
  // currentUsedBytes inner select: user with 0 used storage by default
  mockSelectWhere.mockResolvedValue([{ usedStorageBytes: 0 }]);
  // trim route: mockUpdateReturning returns the "processing" clip
  mockUpdateReturning.mockReturnValue([{ ...INSERTED_CLIP, status: "processing" }]);

  // processClip mock: creates real (empty) output files so downstream fs.stat() succeeds
  mockProcessClip.mockImplementation(
    async ({
      outputPath,
      thumbnailPath,
    }: {
      outputPath: string;
      thumbnailPath: string;
    }) => {
      await fs.writeFile(outputPath, Buffer.alloc(512 * 1024)); // 512 KB
      await fs.writeFile(thumbnailPath, Buffer.alloc(4 * 1024)); // 4 KB
      return { durationSeconds: 2.5, width: 320, height: 240 };
    },
  );

  // storage.getLocalPath returns a readable path inside our temp dir
  mockStorageGetLocalPath.mockImplementation(async (key: string) => {
    const fakePath = path.join(tmpDir, path.basename(key));
    await fs.writeFile(fakePath, Buffer.alloc(ONE_MB)); // 1 MB fake stored file
    return fakePath;
  });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── POST /clips — validation rejections ───────────────────────────────────────

describe("POST /clips — MIME-type validation", () => {
  it("returns 400 when the uploaded file MIME type is not in allowedMimeTypes", async () => {
    const res = await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.from("fake data"), {
        filename: "clip.avi",
        contentType: "video/x-msvideo",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported file type/i);
    // No DB writes should happen
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("accepts a file whose MIME type is in the allowedMimeTypes list", async () => {
    const res = await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.from("fake mp4 data"), {
        filename: "clip.mp4",
        contentType: "video/mp4",
      });

    // 201 means it passed the MIME check (processing is async)
    expect(res.status).toBe(201);
  });
});

describe("POST /clips — per-file size validation", () => {
  it("returns 413 when the file exceeds the configured maxUploadBytes", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxUploadBytes: 10, // tiny limit to trigger rejection on any real upload
    } as Awaited<ReturnType<typeof getSiteSettings>>);

    const res = await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(100), {
        filename: "big.mp4",
        contentType: "video/mp4",
      });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/maximum upload size/i);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("POST /clips — user storage quota validation", () => {
  it("returns 413 when the user has already consumed their entire quota", async () => {
    // User has used exactly their quota (5 GB) → upload denied
    const quotaExhaustedUser = { ...DEFAULT_USER, usedStorageBytes: 5 * ONE_GB };
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxUserStorageBytes: 5 * ONE_GB,
    } as Awaited<ReturnType<typeof getSiteSettings>>);

    const res = await request(buildApp(quotaExhaustedUser))
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/quota/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns 413 when the user has exceeded their quota (over-used)", async () => {
    const overQuotaUser = { ...DEFAULT_USER, usedStorageBytes: 6 * ONE_GB };

    const res = await request(buildApp(overQuotaUser))
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(413);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows upload when user has space remaining (used < quota)", async () => {
    const userWithSpace = { ...DEFAULT_USER, usedStorageBytes: ONE_GB };

    const res = await request(buildApp(userWithSpace))
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(201);
  });

  it("grants GitHub-star bonus: a starred user gets +1 GB over the base quota", async () => {
    // User with 5.5 GB used exceeds the 5 GB base limit but not the 6 GB
    // effective limit earned by starring the GitHub repo.
    const starredUser = {
      ...DEFAULT_USER,
      usedStorageBytes: 5 * ONE_GB + 500 * ONE_MB,
      githubStarBonusGranted: true,
    };
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxUserStorageBytes: 5 * ONE_GB,
    } as Awaited<ReturnType<typeof getSiteSettings>>);

    const res = await request(buildApp(starredUser))
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    // Effective quota = 5 GB + 1 GB star bonus = 6 GB; 5.5 GB used < 6 GB → allowed
    expect(res.status).toBe(201);
  });
});

// ── POST /clips — successful upload ──────────────────────────────────────────

describe("POST /clips — successful upload", () => {
  it("returns 201 with the clip record immediately after the file is accepted", async () => {
    const res = await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), {
        filename: "myclip.mp4",
        contentType: "video/mp4",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(INSERTED_CLIP.id);
    expect(res.body.status).toBe("processing"); // pipeline is async
    expect(res.body.slug).toBe(INSERTED_CLIP.slug);
  });

  it("inserts a clip row with the correct owner, MIME type, and initial status", async () => {
    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), {
        filename: "myclip.mp4",
        contentType: "video/mp4",
      });

    expect(db.insert).toHaveBeenCalledOnce();
    const valuesMock = vi.mocked(db.insert).mock.results[0]!.value
      .values as ReturnType<typeof vi.fn>;
    const insertArg = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(insertArg).toMatchObject({
      ownerId: DEFAULT_USER.id,
      mimeType: "video/mp4",
      status: "processing",
    });
  });
});

// ── POST /clips — async processing pipeline ───────────────────────────────────
//
// `runProcessing` is fire-and-forget (`void runProcessing(...)`), so we call
// flushAsync() after the supertest request to let the pipeline settle before
// checking mock call records.

describe("POST /clips — async processing pipeline (runProcessing)", () => {
  it("invokes processClip and then marks the clip as 'ready' in the DB", async () => {
    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    expect(mockProcessClip).toHaveBeenCalledOnce();

    // At least one db.update().set() call should carry status:'ready'
    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const readyUpdate = allSetArgs.find((a) => a?.status === "ready");

    expect(readyUpdate).toBeDefined();
    expect(readyUpdate).toMatchObject({
      status: "ready",
      durationSeconds: 2.5,
      width: 320,
      height: 240,
    });
  });

  it("puts both the video file and the thumbnail into storage after processing", async () => {
    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    // putFile called twice: once for the video, once for the thumbnail
    expect(mockStoragePutFile).toHaveBeenCalledTimes(2);
    const storedKeys = mockStoragePutFile.mock.calls.map((c) => c[0]);
    expect(storedKeys).toContain(INSERTED_CLIP.storageKey);
    expect(storedKeys).toContain(INSERTED_CLIP.thumbnailKey);
  });

  it("updates the user's usedStorageBytes using the SUM of all ready clips", async () => {
    // processClip mock writes a 512 KB file. After the clip is marked ready,
    // sumReadyClipBytes queries the DB; the mock returns that SUM value.
    const COMPRESSED_SIZE = 512 * 1024;

    // sumReadyClipBytes select returns a SUM aggregate row
    mockSelectWhere.mockResolvedValue([{ total: String(COMPRESSED_SIZE) }]);

    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);

    expect(storageUpdate).toBeDefined();
    // usedStorageBytes is set to the SUM returned by the DB, not computed by
    // adding the file size to a stale counter.
    expect(storageUpdate!.usedStorageBytes).toBe(COMPRESSED_SIZE);
  });

  it("marks the clip as 'failed' when processClip throws", async () => {
    mockProcessClip.mockRejectedValue(new Error("ffmpeg: codec not found"));

    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const failedUpdate = allSetArgs.find((a) => a?.status === "failed");

    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.failureReason).toMatch(/processing failed/i);

    // Storage bytes must NOT have been updated on failure
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });

  it("cleans up both storage keys when the thumbnail upload fails after the video upload succeeds", async () => {
    // First putFile (video) succeeds; second (thumbnail) fails.
    mockStoragePutFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage write error"));

    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    // Clip must be marked failed
    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<Record<string, unknown>>;
    const failedUpdate = allSetArgs.find((a) => a?.status === "failed");
    expect(failedUpdate).toBeDefined();

    // Both storage keys must be deleted to prevent orphaned files
    const deletedKeys = mockStorageDeleteFile.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(INSERTED_CLIP.storageKey);
    expect(deletedKeys).toContain(INSERTED_CLIP.thumbnailKey);

    // usedStorageBytes must NOT be updated
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });

  it("does NOT touch storage when processClip fails before any upload", async () => {
    // processClip throws before putFile is ever called
    mockProcessClip.mockRejectedValue(new Error("ffmpeg: codec not found"));

    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    // No storage keys should be cleaned up — putFile was never called
    expect(mockStorageDeleteFile).not.toHaveBeenCalled();
  });
});

// ── POST /clips/:id/trim — async trim pipeline ────────────────────────────────

describe("POST /clips/:id/trim — async trim pipeline (runTrim)", () => {
  /** A stored clip that owns the trim operation. */
  const STORED_CLIP = {
    ...INSERTED_CLIP,
    status: "ready",
    sizeBytes: ONE_MB, // 1 MB before trimming
    durationSeconds: 4,
    width: 320,
    height: 240,
  };

  beforeEach(() => {
    // First select: loadOwnedClip → existing clip
    // Subsequent selects: sumReadyClipBytes → SUM aggregate row (512 KB, the
    // compressed output size written by the processClip mock)
    mockSelectWhere
      .mockResolvedValueOnce([STORED_CLIP])
      .mockResolvedValue([{ total: String(512 * 1024) }]);

    // .where().returning() used to send the 202 response
    mockUpdateReturning.mockReturnValue([{ ...STORED_CLIP, status: "processing", failureReason: null }]);
  });

  it("returns 202 immediately with status=processing", async () => {
    const res = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("processing");
  });

  it("returns 400 when endSeconds ≤ startSeconds", async () => {
    const res = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 3, endSeconds: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/endSeconds must be greater/i);
  });

  it("marks the clip as 'ready' after a successful trim", async () => {
    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const readyUpdate = allSetArgs.find((a) => a?.status === "ready");

    expect(readyUpdate).toBeDefined();
    expect(readyUpdate).toMatchObject({ status: "ready", durationSeconds: 2.5 });
  });

  it("updates usedStorageBytes using the SUM of all ready clips after trim", async () => {
    // processClip mock writes a 512 KB file. After the clip is marked ready
    // with the new size, sumReadyClipBytes queries the DB; the mock (set in
    // beforeEach) returns 512 KB as the aggregate total.
    const COMPRESSED_SIZE = 512 * 1024;

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);

    expect(storageUpdate).toBeDefined();
    // usedStorageBytes is set to the SUM returned by the DB (512 KB),
    // not computed via the old incremental "current + delta" arithmetic.
    expect(storageUpdate!.usedStorageBytes).toBe(COMPRESSED_SIZE);
  });

  it("marks the clip as 'failed' when processClip throws during trim", async () => {
    mockProcessClip.mockRejectedValue(new Error("ffmpeg crop out of bounds"));

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const failedUpdate = allSetArgs.find((a) => a?.status === "failed");

    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.failureReason).toMatch(/trim|crop/i);

    // Storage bytes must NOT be adjusted on failure
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });

  it("cleans up both storage keys when the thumbnail upload fails after the video upload succeeds during trim", async () => {
    // First putFile (trimmed video) succeeds; second (thumbnail) fails.
    // The original stored video has already been overwritten, so both keys
    // must be removed to prevent a corrupted file from being served later.
    mockStoragePutFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage write error"));

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<Record<string, unknown>>;
    const failedUpdate = allSetArgs.find((a) => a?.status === "failed");
    expect(failedUpdate).toBeDefined();

    const deletedKeys = mockStorageDeleteFile.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(INSERTED_CLIP.storageKey);
    expect(deletedKeys).toContain(INSERTED_CLIP.thumbnailKey);

    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });

  it("does NOT touch storage when processClip fails before any upload during trim", async () => {
    // processClip throws before putFile is ever called — the original stored
    // files are intact and must NOT be deleted.
    mockProcessClip.mockRejectedValue(new Error("ffmpeg crop out of bounds"));

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    expect(mockStorageDeleteFile).not.toHaveBeenCalled();
  });
});

// ── DELETE /clips/:id ─────────────────────────────────────────────────────────

describe("DELETE /clips/:id — non-existent or unowned clip", () => {
  it("returns 404 and touches neither storage nor the byte counter", async () => {
    // DB returns nothing → clip not found / not owned by this user
    mockSelectWhere.mockResolvedValue([]);

    const res = await request(buildApp()).delete("/api/clips/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);

    // Storage must be untouched
    expect(mockStorageDeleteFile).not.toHaveBeenCalled();

    // DB delete and storage accounting must be untouched
    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

describe("DELETE /clips/:id — successful delete of a ready clip", () => {
  /** A ready clip with a known size used for accounting assertions. */
  const READY_CLIP = {
    ...INSERTED_CLIP,
    status: "ready",
    sizeBytes: ONE_MB,
  };

  beforeEach(() => {
    // First select: loadOwnedClip → the ready clip
    // Second select: currentUsedBytes → user currently has 2 MB used
    mockSelectWhere
      .mockResolvedValueOnce([READY_CLIP])
      .mockResolvedValue([{ usedStorageBytes: 2 * ONE_MB }]);
  });

  it("returns 204 No Content", async () => {
    const res = await request(buildApp()).delete("/api/clips/1");
    expect(res.status).toBe(204);
  });

  it("deletes both the video file and the thumbnail from storage", async () => {
    await request(buildApp()).delete("/api/clips/1");

    expect(mockStorageDeleteFile).toHaveBeenCalledTimes(2);
    const deletedKeys = mockStorageDeleteFile.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(READY_CLIP.storageKey);
    expect(deletedKeys).toContain(READY_CLIP.thumbnailKey);
  });

  it("decrements usedStorageBytes by the clip's sizeBytes", async () => {
    await request(buildApp()).delete("/api/clips/1");

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);

    expect(storageUpdate).toBeDefined();
    // 2 MB (current) − 1 MB (clip size) = 1 MB remaining
    expect(storageUpdate!.usedStorageBytes).toBe(ONE_MB);
  });

  it("never lets usedStorageBytes go below zero", async () => {
    // currentUsedBytes returns 0 even though the clip claims 1 MB — drift guard
    mockSelectWhere
      .mockResolvedValueOnce([READY_CLIP])
      .mockResolvedValue([{ usedStorageBytes: 0 }]);

    await request(buildApp()).delete("/api/clips/1");

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);

    expect(storageUpdate).toBeDefined();
    expect(storageUpdate!.usedStorageBytes).toBe(0);
  });
});

describe("DELETE /clips/:id — non-ready clip (processing / failed)", () => {
  it("does NOT decrement usedStorageBytes when deleting a processing clip", async () => {
    const PROCESSING_CLIP = { ...INSERTED_CLIP, status: "processing", sizeBytes: ONE_MB };
    mockSelectWhere.mockResolvedValue([PROCESSING_CLIP]);

    const res = await request(buildApp()).delete("/api/clips/1");

    expect(res.status).toBe(204);

    // Storage files are still cleaned up
    expect(mockStorageDeleteFile).toHaveBeenCalled();

    // But usedStorageBytes must NOT be touched — the size was never committed
    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });

  it("does NOT decrement usedStorageBytes when deleting a failed clip", async () => {
    const FAILED_CLIP = {
      ...INSERTED_CLIP,
      status: "failed",
      sizeBytes: ONE_MB,
      failureReason: "Processing failed",
    };
    mockSelectWhere.mockResolvedValue([FAILED_CLIP]);

    const res = await request(buildApp()).delete("/api/clips/1");

    expect(res.status).toBe(204);

    const allSetArgs = mockUpdateSet.mock.calls.map((c) => c[0]) as Array<
      Record<string, unknown>
    >;
    const storageUpdate = allSetArgs.find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });
});
