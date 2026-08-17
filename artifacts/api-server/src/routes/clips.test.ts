/**
 * Integration tests for the clip upload/trim pipeline (routes/clips.ts).
 *
 * Database, storage driver, ffmpeg, and site-settings are all mocked so no
 * external connections or real ffmpeg invocations are needed here. The real
 * ffmpeg binary is exercised in lib/ffmpeg.test.ts instead.
 *
 * Covers:
 *   POST /clips  — MIME-type rejection, per-file size rejection,
 *                  user quota rejection (including the new used+size check),
 *                  duration-limit rejection, successful upload + DB insert,
 *                  async pipeline marks clip ready + adjusts storage
 *                  accounting by the compressed delta,
 *                  async pipeline marks clip failed when processClip throws
 *                  (and releases the reserved bytes),
 *                  partial storage writes cleaned up when thumbnail upload fails,
 *                  storage left untouched when processClip fails before any upload
 *   POST /clips/:id/trim — 202 immediately, endSeconds validation,
 *                          duration validation, 409 when a job is in flight,
 *                          trim writes NEW keys + swaps + cleans up old keys,
 *                          trim restores the old clip (not failed) on failure,
 *                          partial NEW storage writes cleaned up on trim failure
 *   DELETE /clips/:id — releases the clip's bytes (ready or processing),
 *                       no-op for failed clips
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
  mockProbeVideo,
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
  mockProbeVideo: vi.fn(),
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
          // Attach .returning() so routes can call .where().returning()
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
    discordRolesTable: {},
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
  })),
}));

vi.mock("../lib/ffmpeg", () => ({
  processClip: mockProcessClip,
  probeVideo: mockProbeVideo,
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
import { probeVideo } from "../lib/ffmpeg";
import clipsRouter from "./clips";
import { resetProcessingQueueForTests } from "../lib/processing-queue";

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

/** Every .set({…}) argument recorded across all db.update calls. */
function allSetArgs(): Array<Record<string, unknown>> {
  return mockUpdateSet.mock.calls.map((c) => c[0]) as Array<Record<string, unknown>>;
}

/** The most recent .set({…}) that touched usedStorageBytes, if any. */
function latestStorageSet(): Record<string, unknown> | undefined {
  return [...allSetArgs()].reverse().find((a) => "usedStorageBytes" in a);
}

/**
 * Flatten a drizzle `sql` expression (0.45 shape: nested queryChunks / value
 * arrays) into leaf values — literal SQL strings and number params.
 */
function sqlLeaves(value: unknown): unknown[] {
  const v = value as { queryChunks?: unknown[]; value?: unknown[] };
  if (Array.isArray(v?.queryChunks)) {
    return v.queryChunks.flatMap((c) => sqlLeaves(c));
  }
  if (Array.isArray(v?.value)) {
    return v.value.flatMap((c) => sqlLeaves(c));
  }
  return [value];
}

/** The SQL text of a drizzle `sql` expression used as a column value. */
function sqlText(value: unknown): string {
  return sqlLeaves(value).map(String).join("");
}

/** Numeric parameters embedded in a drizzle `sql` expression. */
function sqlParams(value: unknown): unknown[] {
  return sqlLeaves(value).filter((c) => typeof c === "number");
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  resetProcessingQueueForTests();

  // Create a per-test temp dir so processClip can write real output files
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clippnk-clips-test-"));

  // Default settings
  vi.mocked(getSiteSettings).mockResolvedValue(
    DEFAULT_SETTINGS as Awaited<ReturnType<typeof getSiteSettings>>,
  );

  // Default DB responses
  mockInsertReturning.mockResolvedValue([INSERTED_CLIP]);
  // Generic select fallback: an existing clip/row for existence checks etc.
  mockSelectWhere.mockResolvedValue([INSERTED_CLIP]);
  // trim route: mockUpdateReturning returns the "processing" clip
  mockUpdateReturning.mockReturnValue([{ ...INSERTED_CLIP, status: "processing" }]);

  // probeVideo default (only consulted when maxClipDurationSeconds is set)
  mockProbeVideo.mockResolvedValue({ durationSeconds: 4, width: 320, height: 240 });

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

  it("rejects when used + incoming file size would exceed the quota (over-commit guard)", async () => {
    // 4.5 MB used of a 5 MB quota — the user has room, but a 1 MB file would
    // push them over. The old check (used >= quota) wrongly allowed this.
    const almostFullUser = { ...DEFAULT_USER, usedStorageBytes: 4.5 * ONE_MB };
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxUploadBytes: 10 * ONE_MB,
      maxUserStorageBytes: 5 * ONE_MB,
    } as Awaited<ReturnType<typeof getSiteSettings>>);

    const res = await request(buildApp(almostFullUser))
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/quota/i);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("POST /clips — duration limit validation", () => {
  it("returns 400 when the clip exceeds maxClipDurationSeconds", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxClipDurationSeconds: 10,
    } as Awaited<ReturnType<typeof getSiteSettings>>);
    vi.mocked(probeVideo).mockResolvedValue({ durationSeconds: 25, width: 1920, height: 1080 });

    const res = await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "long.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum allowed is 10s/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("accepts a clip within maxClipDurationSeconds", async () => {
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxClipDurationSeconds: 10,
    } as Awaited<ReturnType<typeof getSiteSettings>>);
    vi.mocked(probeVideo).mockResolvedValue({ durationSeconds: 5, width: 1920, height: 1080 });

    const res = await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "ok.mp4", contentType: "video/mp4" });

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

  it("reserves the original byte count against the user's quota at insert time", async () => {
    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), {
        filename: "myclip.mp4",
        contentType: "video/mp4",
      });

    const reservation = latestStorageSet();
    expect(reservation).toBeDefined();
    // Atomic increment: used_storage_bytes + <file size> (the column ref is
    // "undefined" here only because usersTable is mocked as an empty object)
    expect(sqlParams(reservation!.usedStorageBytes)).toContain(ONE_MB);
  });
});

// ── POST /clips — async processing pipeline ───────────────────────────────────
//
// `runProcessing` is fire-and-forget (queued), so we call flushAsync() after
// the supertest request to let the pipeline settle before checking mocks.

describe("POST /clips — async processing pipeline (runProcessing)", () => {
  it("invokes processClip and then marks the clip as 'ready' in the DB", async () => {
    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    expect(mockProcessClip).toHaveBeenCalledOnce();

    const readyUpdate = allSetArgs().find((a) => a?.status === "ready");
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate).toMatchObject({
      status: "ready",
      durationSeconds: 2.5,
      width: 320,
      height: 240,
    });
  });

  it("stores the re-encoded file with a corrected video/mp4 MIME type", async () => {
    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.webm", contentType: "video/webm" });

    await flushAsync();

    const readyUpdate = allSetArgs().find((a) => a?.status === "ready");
    // Everything is re-encoded to H.264 MP4, so the stored MIME type must be
    // corrected to video/mp4 (previously a webm upload kept its wrong type).
    expect(readyUpdate).toMatchObject({ mimeType: "video/mp4" });
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

  it("replaces the reserved bytes with the compressed size (delta accounting)", async () => {
    const COMPRESSED_SIZE = 512 * 1024;
    const DELTA = COMPRESSED_SIZE - ONE_MB; // negative: file shrank

    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    const storageUpdate = latestStorageSet();
    expect(storageUpdate).toBeDefined();
    // used_storage_bytes = used_storage_bytes + (compressed - original)
    expect(sqlParams(storageUpdate!.usedStorageBytes)).toContain(DELTA);
  });

  it("marks the clip as 'failed' and releases the reserved bytes when processClip throws", async () => {
    mockProcessClip.mockRejectedValue(new Error("ffmpeg: codec not found"));

    await request(buildApp())
      .post("/api/clips")
      .attach("file", Buffer.alloc(ONE_MB), { filename: "clip.mp4", contentType: "video/mp4" });

    await flushAsync();

    const failedUpdate = allSetArgs().find((a) => a?.status === "failed");
    expect(failedUpdate).toBeDefined();
    expect(failedUpdate!.failureReason).toMatch(/ffmpeg: codec not found/i);

    // The reservation must be released so a failed upload doesn't eat quota.
    const release = latestStorageSet();
    expect(release).toBeDefined();
    expect(sqlText(release!.usedStorageBytes)).toContain("GREATEST");
    expect(sqlParams(release!.usedStorageBytes)).toContain(ONE_MB);
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
    const failedUpdate = allSetArgs().find((a) => a?.status === "failed");
    expect(failedUpdate).toBeDefined();

    // Both storage keys must be deleted to prevent orphaned files
    const deletedKeys = mockStorageDeleteFile.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(INSERTED_CLIP.storageKey);
    expect(deletedKeys).toContain(INSERTED_CLIP.thumbnailKey);
  });

  it("does NOT touch storage when processClip fails before any upload", async () => {
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
    // Subsequent selects: existence checks → the same clip
    mockSelectWhere.mockResolvedValue([STORED_CLIP]);

    // .where().returning() used to send the 202 response and to swap pointers
    mockUpdateReturning.mockReturnValue([{ ...STORED_CLIP, status: "processing" }]);
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

  it("returns 400 when the clip is not ready to trim", async () => {
    mockSelectWhere.mockResolvedValue([{ ...STORED_CLIP, status: "processing" }]);

    const res = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not ready to trim/i);
  });

  it("returns 400 when endSeconds exceeds the clip's duration", async () => {
    const res = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the clip's duration/i);
  });

  it("returns 400 when the trimmed length exceeds maxClipDurationSeconds", async () => {
    // A 100s clip trimmed to a 50s window against a 10s limit.
    mockSelectWhere.mockResolvedValue([{ ...STORED_CLIP, durationSeconds: 100 }]);
    vi.mocked(getSiteSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      maxClipDurationSeconds: 10,
    } as Awaited<ReturnType<typeof getSiteSettings>>);

    const res = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 0, endSeconds: 50 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum allowed duration/i);
  });

  it("returns 409 when the clip already has a processing job in flight", async () => {
    // First trim: processClip never resolves, so the per-clip job stays in flight.
    mockProcessClip.mockImplementation(() => new Promise(() => {}));

    const first = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });
    expect(first.status).toBe(202);

    const second = await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 2 });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already being processed/i);
  });

  it("marks the clip as 'ready' after a successful trim", async () => {
    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    const readyUpdate = allSetArgs().find((a) => a?.status === "ready");
    expect(readyUpdate).toBeDefined();
    expect(readyUpdate).toMatchObject({ status: "ready", durationSeconds: 2.5 });
  });

  it("writes trimmed output to NEW keys, swaps the pointers, then cleans up the old keys", async () => {
    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    // putFile must target fresh keys (nanoid mock appends "-test-slug-01"),
    // never overwriting the original files in place.
    const storedKeys = mockStoragePutFile.mock.calls.map((c) => c[0]);
    expect(storedKeys).toContain("clips/test-slug-01-test-slug-01.mp4");
    expect(storedKeys).toContain("clips/test-slug-01-test-slug-01-thumb.jpg");
    expect(storedKeys).not.toContain(STORED_CLIP.storageKey);
    expect(storedKeys).not.toContain(STORED_CLIP.thumbnailKey);

    // The swap update must point the clip at the new keys.
    const readyUpdate = allSetArgs().find((a) => a?.status === "ready");
    expect(readyUpdate).toMatchObject({
      storageKey: "clips/test-slug-01-test-slug-01.mp4",
      thumbnailKey: "clips/test-slug-01-test-slug-01-thumb.jpg",
    });

    // Old files are cleaned up only after the swap succeeded.
    const deletedKeys = mockStorageDeleteFile.mock.calls.map((c) => c[0]);
    expect(deletedKeys).toContain(STORED_CLIP.storageKey);
    expect(deletedKeys).toContain(STORED_CLIP.thumbnailKey);
  });

  it("adjusts usedStorageBytes by the compressed delta after a successful trim", async () => {
    const COMPRESSED_SIZE = 512 * 1024;
    const DELTA = COMPRESSED_SIZE - ONE_MB;

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    const storageUpdate = latestStorageSet();
    expect(storageUpdate).toBeDefined();
    expect(sqlParams(storageUpdate!.usedStorageBytes)).toContain(DELTA);
  });

  it("restores the original clip (not 'failed') when processClip throws during trim", async () => {
    mockProcessClip.mockRejectedValue(new Error("ffmpeg crop out of bounds"));
    // First select: loadOwnedClip → ready clip. Later selects (existence check
    // + restore) see the clip as still "processing" mid-job.
    mockSelectWhere
      .mockResolvedValueOnce([STORED_CLIP])
      .mockResolvedValue([{ ...STORED_CLIP, status: "processing" }]);

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    // The clip must be restored to ready with a recorded reason — the original
    // files are untouched, so it's still playable. It must NOT be marked failed.
    const restore = allSetArgs().find((a) => a?.status === "ready" && a?.failureReason);
    expect(restore).toBeDefined();
    expect(String(restore!.failureReason)).toMatch(/ffmpeg crop out of bounds/i);
    expect(allSetArgs().some((a) => a?.status === "failed")).toBe(false);
  });

  it("cleans up the NEW keys (not the originals) when the thumbnail upload fails during trim", async () => {
    // First putFile (new video) succeeds; second (new thumbnail) fails.
    mockStoragePutFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage write error"));

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    // Only the partially-written NEW files are removed; the originals survive.
    const deletedKeys = mockStorageDeleteFile.mock.calls.map((c) => c[0]);
    expect(deletedKeys).not.toContain(STORED_CLIP.storageKey);
    expect(deletedKeys).not.toContain(STORED_CLIP.thumbnailKey);
    expect(deletedKeys).toContain("clips/test-slug-01-test-slug-01.mp4");
    expect(deletedKeys).toContain("clips/test-slug-01-test-slug-01-thumb.jpg");
  });

  it("does NOT touch storage when processClip fails before any upload during trim", async () => {
    mockProcessClip.mockRejectedValue(new Error("ffmpeg crop out of bounds"));

    await request(buildApp())
      .post("/api/clips/1/trim")
      .send({ startSeconds: 1, endSeconds: 3 });

    await flushAsync();

    // No new files were written, so nothing to clean up — and the originals
    // must never be deleted.
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
    mockSelectWhere.mockResolvedValue([READY_CLIP]);
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

  it("releases the clip's bytes with an atomic, floored decrement", async () => {
    await request(buildApp()).delete("/api/clips/1");

    const storageUpdate = latestStorageSet();
    expect(storageUpdate).toBeDefined();
    // used_storage_bytes = GREATEST(used_storage_bytes - <size>, 0)
    expect(sqlText(storageUpdate!.usedStorageBytes)).toContain("GREATEST");
    expect(sqlParams(storageUpdate!.usedStorageBytes)).toContain(ONE_MB);
  });
});

describe("DELETE /clips/:id — processing clip", () => {
  it("releases the reserved bytes when deleting a processing clip", async () => {
    // A processing clip holds a reservation of its original size; deleting it
    // must release those bytes (the in-flight pipeline is then a no-op because
    // the row is gone).
    const PROCESSING_CLIP = { ...INSERTED_CLIP, status: "processing", sizeBytes: ONE_MB };
    mockSelectWhere.mockResolvedValue([PROCESSING_CLIP]);

    const res = await request(buildApp()).delete("/api/clips/1");

    expect(res.status).toBe(204);

    // Storage files are still cleaned up (best-effort; may not exist yet)
    expect(mockStorageDeleteFile).toHaveBeenCalled();

    const storageUpdate = latestStorageSet();
    expect(storageUpdate).toBeDefined();
    expect(sqlText(storageUpdate!.usedStorageBytes)).toContain("GREATEST");
    expect(sqlParams(storageUpdate!.usedStorageBytes)).toContain(ONE_MB);
  });
});

describe("DELETE /clips/:id — failed clip", () => {
  it("does NOT adjust usedStorageBytes when deleting a failed clip", async () => {
    // Failed clips hold no reservation (released when they failed), so there
    // is nothing to release here.
    const FAILED_CLIP = {
      ...INSERTED_CLIP,
      status: "failed",
      sizeBytes: ONE_MB,
      failureReason: "Processing failed",
    };
    mockSelectWhere.mockResolvedValue([FAILED_CLIP]);

    const res = await request(buildApp()).delete("/api/clips/1");

    expect(res.status).toBe(204);

    const storageUpdate = allSetArgs().find((a) => "usedStorageBytes" in a);
    expect(storageUpdate).toBeUndefined();
  });
});
