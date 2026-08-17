/**
 * In-process queue for ffmpeg processing jobs (upload compression + trim).
 *
 * Why a queue:
 *  - Every job spawns one or more ffmpeg child processes; unbounded
 *    concurrency lets a handful of users exhaust CPU/RAM on the server.
 *  - A per-clip in-flight guard prevents the same clip from being trimmed
 *    twice (or trimmed while uploading), which previously could race on the
 *    same storage key and corrupt the stored file.
 *
 * Jobs are still run in-process (no external broker) — good enough for a
 * single-instance deployment, which is the supported topology.
 */

import { eq, sql } from "drizzle-orm";
import { db, clipsTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

const MAX_CONCURRENCY = Number(process.env.PROCESSING_CONCURRENCY ?? 2);

type Job = () => Promise<void>;

const queue: Job[] = [];
/** Clip ids that currently have a job queued or running (dedup guard). */
const inFlightClipIds = new Set<number>();
let activeCount = 0;

function pump(): void {
  while (activeCount < MAX_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    activeCount += 1;
    void job().finally(() => {
      activeCount -= 1;
      pump();
    });
  }
}

/**
 * Queue a processing job for `clipId`. Returns false (without queueing) when
 * the clip already has a queued/running job — callers should respond 409.
 */
export function enqueueClipJob(clipId: number, job: Job): boolean {
  if (inFlightClipIds.has(clipId)) {
    return false;
  }
  inFlightClipIds.add(clipId);
  queue.push(async () => {
    try {
      await job();
    } finally {
      inFlightClipIds.delete(clipId);
    }
  });
  pump();
  return true;
}

/** Test-only: clear queue state so tests don't leak in-flight markers. */
export function resetProcessingQueueForTests(): void {
  queue.length = 0;
  inFlightClipIds.clear();
  activeCount = 0;
}

/**
 * Startup crash recovery. Clips stuck in `processing` after a server restart
 * can never finish (their temp input files are gone), so they are marked
 * failed instead of lingering forever. Storage counters are then recomputed
 * from the authoritative SUM of ready clips, which also releases any byte
 * reservations that were lost when the server crashed mid-job.
 *
 * Safe to run at boot: no jobs exist yet, so nothing is in flight.
 */
export async function recoverInterruptedProcessing(): Promise<number> {
  const stuck = await db
    .update(clipsTable)
    .set({
      status: "failed",
      failureReason: "Processing interrupted by server restart",
    })
    .where(eq(clipsTable.status, "processing"))
    .returning({ id: clipsTable.id });

  // Recompute every user's counter from the DB sum (single source of truth).
  await db.execute(sql`
    UPDATE users
    SET used_storage_bytes = COALESCE(
      (SELECT SUM(clips.size_bytes) FROM clips
       WHERE clips.owner_id = users.id AND clips.status = 'ready'),
      0
    )
  `);

  const recoveredCount = stuck.length;
  if (recoveredCount > 0) {
    logger.info({ recoveredCount }, "Marked interrupted clips as failed and reconciled storage counters");
  }
  return recoveredCount;
}
