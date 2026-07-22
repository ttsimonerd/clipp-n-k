import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sum } from "drizzle-orm";
import { db, clipsTable, usersTable, type Clip } from "@workspace/db";
import {
  ListClipsResponse,
  GetClipResponse,
  UpdateClipBody,
  UpdateClipResponse,
  TrimClipBody,
  TrimClipResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { getSiteSettings } from "../lib/site-settings";
import { getStorageDriver } from "../lib/storage";
import { effectiveQuotaBytes } from "../lib/quota";
import { probeVideo, processClip } from "../lib/ffmpeg";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Dynamic upload middleware: reads maxUploadBytes from site settings before
 * multer starts writing to disk, so the per-file limit is enforced at the
 * streaming layer rather than after the full file has already landed in /tmp.
 *
 * This prevents a malicious or mistaken client from exhausting disk space by
 * sending multiple large uploads whose size exceeds the admin-configured limit
 * (the old static 2 GB ceiling would allow that regardless of settings).
 *
 * When the limit is exceeded multer emits a MulterError with code
 * LIMIT_FILE_SIZE; we catch it here and return 413 immediately so the route
 * handler never runs and no disk space is wasted.
 */
async function dynamicUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  let settings;
  try {
    settings = await getSiteSettings();
  } catch (err) {
    next(err);
    return;
  }

  const uploader = multer({
    dest: path.join(os.tmpdir(), "clippnk-uploads"),
    limits: { fileSize: settings.maxUploadBytes },
  }).single("file");

  uploader(req, res, (err) => {
    if (err) {
      // multer exceeded the fileSize limit — reject before the handler sees the file
      if ((err as { code?: string }).code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File exceeds the maximum upload size" });
        return;
      }
      next(err);
      return;
    }
    next();
  });
}

function serializeClip(clip: Clip, req: { protocol: string; get: (h: string) => string | undefined }): unknown {
  const origin = `${req.protocol}://${req.get("host")}`;
  return {
    id: clip.id,
    slug: clip.slug,
    title: clip.title,
    originalFilename: clip.originalFilename,
    mimeType: clip.mimeType,
    sizeBytes: clip.sizeBytes,
    durationSeconds: clip.durationSeconds,
    width: clip.width,
    height: clip.height,
    // Owner-authenticated playback URL, streamed through /clips/:id/video
    // (which enforces ownership) rather than the storage driver's
    // getPublicUrl() -- that URL is unauthenticated and must only ever be
    // handed out for clips that are actually visibility=public (see
    // routes/public.ts and routes/share.ts).
    videoUrl: clip.status === "ready" ? `${origin}/api/clips/${clip.id}/video` : null,
    thumbnailUrl: clip.thumbnailKey ? `${origin}/api/clips/${clip.id}/thumbnail` : null,
    visibility: clip.visibility,
    status: clip.status,
    failureReason: clip.failureReason,
    shareUrl: `${origin}/c/${clip.slug}`,
    createdAt: clip.createdAt.toISOString(),
    updatedAt: clip.updatedAt.toISOString(),
  };
}

async function loadOwnedClip(req: { currentUser?: { id: number } }, id: number): Promise<Clip | undefined> {
  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(and(eq(clipsTable.id, id), eq(clipsTable.ownerId, req.currentUser!.id)));
  return clip;
}

router.get("/clips", requireAuth, async (req, res): Promise<void> => {
  const clips = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.ownerId, req.currentUser!.id))
    .orderBy(clipsTable.createdAt);
  const data = ListClipsResponse.parse(
    clips.map((clip) => serializeClip(clip, req)).reverse(),
  );
  res.json(data);
});

router.post(
  "/clips",
  requireAuth,
  dynamicUpload,
  async (req, res): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const settings = await getSiteSettings();
    const user = req.currentUser!;

    const cleanup = async (): Promise<void> => {
      await fs.rm(file.path, { force: true });
    };

    if (!settings.allowedMimeTypes.includes(file.mimetype)) {
      await cleanup();
      res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      return;
    }

    // Belt-and-suspenders: multer already enforced fileSize ≤ maxUploadBytes
    // via dynamicUpload, but we keep this check in case multer's limit and the
    // settings row diverged (e.g. settings were updated between middleware and
    // handler execution).
    if (file.size > settings.maxUploadBytes) {
      await cleanup();
      res.status(413).json({ error: "File exceeds the maximum upload size" });
      return;
    }

    if (user.usedStorageBytes >= effectiveQuotaBytes(user, settings)) {
      await cleanup();
      res.status(413).json({ error: "Storage quota exceeded. Delete a clip to free up space." });
      return;
    }

    const slug = nanoid(10);
    const title =
      typeof req.body.title === "string" && req.body.title.trim().length > 0
        ? req.body.title.trim()
        : file.originalname;

    const [clip] = await db
      .insert(clipsTable)
      .values({
        ownerId: user.id,
        slug,
        title,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey: `clips/${slug}.mp4`,
        thumbnailKey: `clips/${slug}-thumb.jpg`,
        visibility: settings.defaultVisibility,
        status: "processing",
      })
      .returning();

    res.status(201).json(GetClipResponse.parse(serializeClip(clip!, req)));

    void runProcessing(clip!, file.path);
  },
);

async function runProcessing(clip: Clip, inputPath: string): Promise<void> {
  const storage = getStorageDriver();
  const outputPath = path.join(os.tmpdir(), `clippnk-out-${clip.slug}.mp4`);
  const thumbnailPath = path.join(os.tmpdir(), `clippnk-thumb-${clip.slug}.jpg`);
  // Track whether putFile has started so we know what to clean up on failure.
  let putFileStarted = false;

  try {
    const probe = await processClip({ inputPath, outputPath, thumbnailPath });
    const stat = await fs.stat(outputPath);

    putFileStarted = true;
    await storage.putFile(clip.storageKey, outputPath);
    await storage.putFile(clip.thumbnailKey!, thumbnailPath);

    await db
      .update(clipsTable)
      .set({
        status: "ready",
        sizeBytes: stat.size,
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
      })
      .where(eq(clipsTable.id, clip.id));

    // Recompute from the authoritative DB sum rather than maintaining the
    // counter incrementally. This keeps the quota byte count consistent even
    // if a previous write crashed between the clip update and the user update.
    await db
      .update(usersTable)
      .set({ usedStorageBytes: await sumReadyClipBytes(clip.ownerId) })
      .where(eq(usersTable.id, clip.ownerId));
  } catch (err) {
    logger.error({ err, clipId: clip.id }, "Clip processing failed");
    // If putFile already started, partial files may exist in storage. Delete
    // both keys; StorageDriver.deleteFile is documented to not throw on missing
    // keys so this is always safe.
    if (putFileStarted) {
      await storage.deleteFile(clip.storageKey).catch(() => {});
      if (clip.thumbnailKey) {
        await storage.deleteFile(clip.thumbnailKey).catch(() => {});
      }
    }
    await db
      .update(clipsTable)
      .set({ status: "failed", failureReason: "Processing failed" })
      .where(eq(clipsTable.id, clip.id));
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
    await fs.rm(thumbnailPath, { force: true });
  }
}

/**
 * Recompute the total bytes consumed by all ready clips owned by `userId`.
 * Using a SUM query (rather than incrementally maintaining a running total)
 * means the counter stays correct even if the server crashes between the clip
 * status update and the user row update.
 */
async function sumReadyClipBytes(userId: number): Promise<number> {
  const [row] = await db
    .select({ total: sum(clipsTable.sizeBytes) })
    .from(clipsTable)
    .where(and(eq(clipsTable.ownerId, userId), eq(clipsTable.status, "ready")));
  return Number(row?.total ?? 0);
}

async function currentUsedBytes(userId: number): Promise<number> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  return user?.usedStorageBytes ?? 0;
}

router.get("/clips/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const clip = await loadOwnedClip(req, id);
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  res.json(GetClipResponse.parse(serializeClip(clip, req)));
});

// Authenticated media streaming. Deliberately NOT served via a public static
// route: ownership is checked on every request so a private clip's video
// can't be fetched by anyone who merely has the URL. supports Range so
// seeking works in the <video> element.
router.get("/clips/:id/video", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const clip = await loadOwnedClip(req, id);
  if (!clip || clip.status !== "ready") {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const storage = getStorageDriver();
  const localPath = await storage.getLocalPath(clip.storageKey);
  res.sendFile(localPath, {
    headers: { "Content-Type": clip.mimeType },
  });
});

router.get("/clips/:id/thumbnail", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const clip = await loadOwnedClip(req, id);
  if (!clip || !clip.thumbnailKey) {
    res.status(404).json({ error: "Thumbnail not found" });
    return;
  }
  const storage = getStorageDriver();
  const localPath = await storage.getLocalPath(clip.thumbnailKey);
  res.sendFile(localPath, {
    headers: { "Content-Type": "image/jpeg" },
  });
});

router.patch("/clips/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = UpdateClipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select()
    .from(clipsTable)
    .where(and(eq(clipsTable.id, id), eq(clipsTable.ownerId, req.currentUser!.id)));
  if (!existing) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const [updated] = await db
    .update(clipsTable)
    .set(parsed.data)
    .where(eq(clipsTable.id, id))
    .returning();

  res.json(UpdateClipResponse.parse(serializeClip(updated!, req)));
});

router.delete("/clips/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db
    .select()
    .from(clipsTable)
    .where(and(eq(clipsTable.id, id), eq(clipsTable.ownerId, req.currentUser!.id)));
  if (!existing) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const storage = getStorageDriver();
  await storage.deleteFile(existing.storageKey);
  if (existing.thumbnailKey) {
    await storage.deleteFile(existing.thumbnailKey);
  }

  await db.delete(clipsTable).where(eq(clipsTable.id, id));

  if (existing.status === "ready") {
    await db
      .update(usersTable)
      .set({
        usedStorageBytes: Math.max(
          0,
          (await currentUsedBytes(existing.ownerId)) - existing.sizeBytes,
        ),
      })
      .where(eq(usersTable.id, existing.ownerId));
  }

  res.status(204).end();
});

router.post("/clips/:id/trim", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = TrimClipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.endSeconds <= parsed.data.startSeconds) {
    res.status(400).json({ error: "endSeconds must be greater than startSeconds" });
    return;
  }

  const [existing] = await db
    .select()
    .from(clipsTable)
    .where(and(eq(clipsTable.id, id), eq(clipsTable.ownerId, req.currentUser!.id)));
  if (!existing) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const [updated] = await db
    .update(clipsTable)
    .set({ status: "processing", failureReason: null })
    .where(eq(clipsTable.id, id))
    .returning();

  res.status(202).json(TrimClipResponse.parse(serializeClip(updated!, req)));

  void runTrim(updated!, parsed.data);
});

async function runTrim(
  clip: Clip,
  trim: {
    startSeconds: number;
    endSeconds: number;
    cropX?: number | null;
    cropY?: number | null;
    cropWidth?: number | null;
    cropHeight?: number | null;
  },
): Promise<void> {
  const storage = getStorageDriver();
  const inputPath = path.join(os.tmpdir(), `clippnk-trim-in-${clip.slug}.mp4`);
  const outputPath = path.join(os.tmpdir(), `clippnk-trim-out-${clip.slug}.mp4`);
  const thumbnailPath = path.join(os.tmpdir(), `clippnk-trim-thumb-${clip.slug}.jpg`);

  // Track whether putFile has started. For trim the original file is
  // overwritten in-place, so if putFile starts and then fails the stored
  // content may be corrupted — we must clean up both keys regardless.
  let putFileStarted = false;

  try {
    const currentLocalPath = await storage.getLocalPath(clip.storageKey);
    await fs.copyFile(currentLocalPath, inputPath);

    const probe = await processClip({
      inputPath,
      outputPath,
      thumbnailPath,
      startSeconds: trim.startSeconds,
      endSeconds: trim.endSeconds,
      cropX: trim.cropX,
      cropY: trim.cropY,
      cropWidth: trim.cropWidth,
      cropHeight: trim.cropHeight,
    });
    const stat = await fs.stat(outputPath);

    putFileStarted = true;
    await storage.putFile(clip.storageKey, outputPath);
    await storage.putFile(clip.thumbnailKey!, thumbnailPath);

    await db
      .update(clipsTable)
      .set({
        status: "ready",
        sizeBytes: stat.size,
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
      })
      .where(eq(clipsTable.id, clip.id));

    // Recompute from the authoritative DB sum (same rationale as runProcessing).
    await db
      .update(usersTable)
      .set({ usedStorageBytes: await sumReadyClipBytes(clip.ownerId) })
      .where(eq(usersTable.id, clip.ownerId));
  } catch (err) {
    logger.error({ err, clipId: clip.id }, "Clip trim failed");
    // If putFile started, the stored content may be partially overwritten.
    // Clean up both keys so the failed clip can't be served as a valid video.
    if (putFileStarted) {
      await storage.deleteFile(clip.storageKey).catch(() => {});
      if (clip.thumbnailKey) {
        await storage.deleteFile(clip.thumbnailKey).catch(() => {});
      }
    }
    await db
      .update(clipsTable)
      .set({ status: "failed", failureReason: "Trim/crop failed" })
      .where(eq(clipsTable.id, clip.id));
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
    await fs.rm(thumbnailPath, { force: true });
  }
}

export default router;
