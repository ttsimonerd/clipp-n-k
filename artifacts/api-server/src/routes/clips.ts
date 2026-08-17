import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
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
import { resolveUserLimits } from "../lib/limits";
import { postChannelMessage } from "../lib/discord";
import { probeVideo, processClip } from "../lib/ffmpeg";
import { enqueueClipJob } from "../lib/processing-queue";
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
  let uploadBytes: number;
  try {
    const settings = await getSiteSettings();
    // Resolve the per-user upload limit (role-aware) BEFORE multer starts
    // writing to disk, so the streaming layer enforces the right ceiling.
    const limits = await resolveUserLimits(req.currentUser!, settings);
    uploadBytes = limits.uploadBytes;
  } catch (err) {
    next(err);
    return;
  }

  const uploader = multer({
    dest: path.join(os.tmpdir(), "clippnk-uploads"),
    limits: { fileSize: uploadBytes },
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

/** Human-readable failure reason for a clip, bounded in length. */
function failureMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return err.message.slice(0, 300);
  }
  return fallback;
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
    // The thumbnail file only exists once processing finishes, so only hand
    // out its URL for ready clips. Processing/failed clips previously got a
    // non-null URL pointing at a missing file (broken <img>, 500 responses).
    thumbnailUrl:
      clip.status === "ready" && clip.thumbnailKey
        ? `${origin}/api/clips/${clip.id}/thumbnail`
        : null,
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
    const limits = await resolveUserLimits(user, settings);

    const cleanup = async (): Promise<void> => {
      await fs.rm(file.path, { force: true });
    };

    if (!settings.allowedMimeTypes.includes(file.mimetype)) {
      await cleanup();
      res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      return;
    }

    // Belt-and-suspenders: multer already enforced fileSize ≤ upload limit
    // via dynamicUpload, but we keep this check in case the resolved limit and
    // the settings row diverged (e.g. settings were updated between middleware
    // and handler execution).
    if (file.size > limits.uploadBytes) {
      await cleanup();
      res.status(413).json({ error: "File exceeds the maximum upload size" });
      return;
    }

    // Quota admission: reject when the user would go OVER their effective
    // quota, not merely when they are already at/over it. The old check
    // (used >= quota) let users over-shoot by up to a full max-size file.
    if (user.usedStorageBytes + file.size > limits.quotaBytes) {
      await cleanup();
      res.status(413).json({ error: "Storage quota exceeded. Delete a clip to free up space." });
      return;
    }

    // Enforce the admin-configured maximum clip duration up-front (the
    // setting previously existed in the DB/admin UI but was never checked).
    if (settings.maxClipDurationSeconds != null) {
      try {
        const probe = await probeVideo(file.path);
        if (
          probe.durationSeconds != null &&
          probe.durationSeconds > settings.maxClipDurationSeconds
        ) {
          await cleanup();
          res.status(400).json({
            error: `Clip is ${Math.round(probe.durationSeconds)}s long; the maximum allowed is ${settings.maxClipDurationSeconds}s.`,
          });
          return;
        }
      } catch (err) {
        // Unprobeable file — let the processing pipeline surface the failure
        // with a proper "failed" status instead of blocking the upload here.
        logger.warn({ err }, "Failed to probe upload for duration limit check");
      }
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

    // Reserve the original byte count against the user's quota atomically.
    // Concurrent uploads can no longer all pass the admission check and then
    // collectively blow past the quota: each reservation is an atomic
    // increment, and the pipeline releases/replaces it once processing ends.
    await db
      .update(usersTable)
      .set({
        usedStorageBytes: sql`${usersTable.usedStorageBytes} + ${file.size}`,
      })
      .where(eq(usersTable.id, user.id));

    res.status(201).json(GetClipResponse.parse(serializeClip(clip!, req)));

    // The clip id is brand new so the per-clip in-flight guard can't trip;
    // ignore its return value (it can only be false on an id collision).
    enqueueClipJob(clip!.id, () => runProcessing(clip!, file.path));
  },
);

async function runProcessing(clip: Clip, inputPath: string): Promise<void> {
  const storage = getStorageDriver();
  const outputPath = path.join(os.tmpdir(), `clippnk-out-${clip.slug}.mp4`);
  const thumbnailPath = path.join(os.tmpdir(), `clippnk-thumb-${clip.slug}.jpg`);
  // Track whether putFile has started so we know what to clean up on failure.
  let putFileStarted = false;

  try {
    // Bail if the clip was deleted while this job was queued/running — the
    // delete handler already released the quota reservation and removed the
    // row, so writing files now would only orphan them.
    const [current] = await db
      .select()
      .from(clipsTable)
      .where(eq(clipsTable.id, clip.id));
    if (!current) {
      return;
    }

    const probe = await processClip({ inputPath, outputPath, thumbnailPath });
    const stat = await fs.stat(outputPath);

    putFileStarted = true;
    await storage.putFile(clip.storageKey, outputPath);
    await storage.putFile(clip.thumbnailKey!, thumbnailPath);

    // Swap the reserved original size for the compressed size, atomically.
    // `clip.sizeBytes` is the original upload size (the row hasn't changed
    // since insert — per-clip jobs are serialized by the queue).
    const delta = stat.size - clip.sizeBytes;

    const [updated] = await db
      .update(clipsTable)
      .set({
        status: "ready",
        sizeBytes: stat.size,
        // Everything is re-encoded to H.264 MP4, so the stored MIME type is
        // always video/mp4 — previously a webm/mov upload kept its original
        // (now wrong) Content-Type while the bytes were MP4.
        mimeType: "video/mp4",
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
      })
      .where(eq(clipsTable.id, clip.id))
      .returning();

    if (updated) {
      await db
        .update(usersTable)
        .set({
          usedStorageBytes: sql`${usersTable.usedStorageBytes} + ${delta}`,
        })
        .where(eq(usersTable.id, clip.ownerId));
    }
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
    // Only touch the row/counter if the clip still exists (it may have been
    // deleted while processing — in which case the delete handler already
    // released the reservation).
    const [row] = await db.select().from(clipsTable).where(eq(clipsTable.id, clip.id));
    if (row) {
      await db
        .update(clipsTable)
        .set({ status: "failed", failureReason: failureMessage(err, "Processing failed") })
        .where(eq(clipsTable.id, clip.id));
      // Release the reserved bytes so a failed upload doesn't permanently
      // eat quota (GREATEST guards against drift pushing it negative).
      await db
        .update(usersTable)
        .set({
          usedStorageBytes: sql`GREATEST(${usersTable.usedStorageBytes} - ${clip.sizeBytes}, 0)`,
        })
        .where(eq(usersTable.id, clip.ownerId));
    }
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
    await fs.rm(thumbnailPath, { force: true });
  }
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
  if (!clip || clip.status !== "ready" || !clip.thumbnailKey) {
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

  // Release the bytes this clip holds against the quota: its reserved
  // original size while processing, its compressed size once ready.
  // Failed clips hold no reservation (released when they failed).
  // The decrement is atomic and floored at zero to survive counter drift.
  if (existing.status !== "failed") {
    await db
      .update(usersTable)
      .set({
        usedStorageBytes: sql`GREATEST(${usersTable.usedStorageBytes} - ${existing.sizeBytes}, 0)`,
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
  if (existing.status !== "ready") {
    res.status(400).json({ error: "Clip is not ready to trim" });
    return;
  }
  if (
    existing.durationSeconds != null &&
    parsed.data.endSeconds > existing.durationSeconds + 0.001
  ) {
    res.status(400).json({ error: "endSeconds exceeds the clip's duration" });
    return;
  }

  const settings = await getSiteSettings();
  if (
    settings.maxClipDurationSeconds != null &&
    parsed.data.endSeconds - parsed.data.startSeconds > settings.maxClipDurationSeconds
  ) {
    res.status(400).json({
      error: `Trimmed length exceeds the maximum allowed duration of ${settings.maxClipDurationSeconds}s`,
    });
    return;
  }

  // Claim the per-clip processing slot FIRST so two concurrent trims (or a
  // trim racing the original upload's processing) can't both proceed — one
  // gets 409, the other owns the clip until its job finishes.
  const queued = enqueueClipJob(existing.id, () => runTrim(existing, parsed.data));
  if (!queued) {
    res.status(409).json({ error: "Clip is already being processed" });
    return;
  }

  const [updated] = await db
    .update(clipsTable)
    .set({ status: "processing", failureReason: null })
    .where(eq(clipsTable.id, id))
    .returning();

  res.status(202).json(TrimClipResponse.parse(serializeClip(updated!, req)));
});

/**
 * Trim/crop a clip by writing the result to NEW storage keys and atomically
 * swapping the clip's pointers, then deleting the old objects.
 *
 * The previous implementation overwrote the stored file in place: a failure
 * part-way through (e.g. the thumbnail upload failing after the video upload
 * succeeded) corrupted or destroyed the user's only copy of the clip. With
 * write-new-then-swap, the original stays intact until the new files are
 * fully in place, and on failure we simply restore the old state.
 */
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
  const newKey = `clips/${clip.slug}-${nanoid(8)}.mp4`;
  const newThumbKey = `clips/${clip.slug}-${nanoid(8)}-thumb.jpg`;
  const inputPath = path.join(os.tmpdir(), `clippnk-trim-in-${clip.slug}.mp4`);
  const outputPath = path.join(os.tmpdir(), `clippnk-trim-out-${clip.slug}.mp4`);
  const thumbnailPath = path.join(os.tmpdir(), `clippnk-trim-thumb-${clip.slug}.jpg`);

  // Track whether putFile has started so we know what to clean up on failure.
  let putFileStarted = false;

  try {
    // Bail if the clip was deleted while this job was queued/running.
    const [current] = await db
      .select()
      .from(clipsTable)
      .where(eq(clipsTable.id, clip.id));
    if (!current) {
      return;
    }

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

    // Write to fresh keys — the originals are untouched until the swap.
    putFileStarted = true;
    await storage.putFile(newKey, outputPath);
    await storage.putFile(newThumbKey, thumbnailPath);

    const delta = stat.size - clip.sizeBytes;

    // Atomically swap the pointers (guarded on status so a concurrent delete
    // can't leave us updating a row that no longer owns these files).
    const [updated] = await db
      .update(clipsTable)
      .set({
        status: "ready",
        storageKey: newKey,
        thumbnailKey: newThumbKey,
        sizeBytes: stat.size,
        mimeType: "video/mp4",
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
      })
      .where(and(eq(clipsTable.id, clip.id), eq(clipsTable.status, "processing")))
      .returning();

    if (updated) {
      await db
        .update(usersTable)
        .set({
          usedStorageBytes: sql`${usersTable.usedStorageBytes} + ${delta}`,
        })
        .where(eq(usersTable.id, clip.ownerId));
      // Old files are no longer referenced — clean them up best-effort.
      await storage.deleteFile(clip.storageKey).catch(() => {});
      if (clip.thumbnailKey) {
        await storage.deleteFile(clip.thumbnailKey).catch(() => {});
      }
    } else {
      // The row changed/deleted mid-trim; remove the files we just wrote.
      await storage.deleteFile(newKey).catch(() => {});
      await storage.deleteFile(newThumbKey).catch(() => {});
    }
  } catch (err) {
    logger.error({ err, clipId: clip.id }, "Clip trim failed");
    // Remove any partially-written NEW files. The originals are untouched,
    // so the clip is simply restored to its pre-trim state.
    if (putFileStarted) {
      await storage.deleteFile(newKey).catch(() => {});
      await storage.deleteFile(newThumbKey).catch(() => {});
    }
    const [row] = await db.select().from(clipsTable).where(eq(clipsTable.id, clip.id));
    if (row && row.status === "processing") {
      // Restore the previous, intact clip rather than marking it failed —
      // the original files are still in storage under the old keys.
      await db
        .update(clipsTable)
        .set({ status: "ready", failureReason: failureMessage(err, "Trim failed") })
        .where(eq(clipsTable.id, clip.id));
    }
  } finally {
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
    await fs.rm(thumbnailPath, { force: true });
  }
}

/**
 * "Share to Discord" — posts a link to a ready, PUBLIC clip into the
 * admin-configured share channel via the Discord bot. Requires the clip to be
 * public because the link is opened by other Discord users (a private clip's
 * share page would 404 for them).
 */
router.post("/clips/:id/share-discord", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const clip = await loadOwnedClip(req, id);
  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  if (clip.status !== "ready") {
    res.status(400).json({ error: "Clip is still processing" });
    return;
  }
  if (clip.visibility !== "public") {
    res.status(400).json({ error: "Only public clips can be shared to Discord" });
    return;
  }

  const settings = await getSiteSettings();
  if (!settings.discordShareChannelId) {
    res.status(400).json({ error: "Discord sharing is not configured by the admin" });
    return;
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const shareUrl = `${origin}/c/${clip.slug}`;
  try {
    await postChannelMessage(
      settings.discordShareChannelId,
      `**${clip.title}**\n${shareUrl}`,
    );
  } catch (err) {
    logger.error({ err, clipId: clip.id }, "Failed to share clip to Discord");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Failed to share to Discord",
    });
    return;
  }

  res.status(204).end();
});

export default router;
