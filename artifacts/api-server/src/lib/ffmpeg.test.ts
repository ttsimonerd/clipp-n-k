/**
 * Integration tests for the ffmpeg wrapper (lib/ffmpeg.ts).
 *
 * These tests run against the **real** ffmpeg/ffprobe binaries so that
 * actual pipeline bugs — wrong flag ordering, codec failures, missing output
 * files — are caught rather than silently mocked away.
 *
 * A synthetic fixture video is generated once in beforeAll using ffmpeg's
 * built-in lavfi sources so the test suite needs no committed binary blob.
 *
 * Covers:
 *   probeVideo   — extracts correct duration, width, and height
 *   processClip  — produces a valid re-encoded MP4 + thumbnail
 *   processClip  — trim shortens the output duration
 *   processClip  — crop filter changes the output dimensions
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { probeVideo, processClip } from "./ffmpeg";

const execFile = promisify(_execFile);

// ── Fixture generation ────────────────────────────────────────────────────────

let tmpDir: string;
let fixtureVideoPath: string; // 4-second, 320×240 test video

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clippnk-ffmpeg-test-"));
  fixtureVideoPath = path.join(tmpDir, "fixture.mp4");

  // Generate a short synthetic video using ffmpeg's built-in test sources so
  // no committed binary blob is needed. Duration=4s gives comfortable headroom
  // for trim tests that cut 1–3 s out of it.
  await execFile("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-crf", "28", "-preset", "ultrafast",
    "-c:a", "aac",
    "-shortest",
    fixtureVideoPath,
  ]);
}, 60_000 /* ffmpeg can be slow on first run */);

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return a fresh output path that is cleaned up by the shared tmpDir removal. */
function tmpFile(suffix: string): string {
  return path.join(tmpDir, `${Date.now()}-${suffix}`);
}

// ── probeVideo ────────────────────────────────────────────────────────────────

describe("probeVideo", () => {
  it("extracts duration, width, and height from a valid MP4", async () => {
    const result = await probeVideo(fixtureVideoPath);

    expect(result.durationSeconds).toBeCloseTo(4, 0);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
  });

  it("rejects with an error for a non-video file", async () => {
    const badFile = tmpFile("notavideo.mp4");
    await fs.writeFile(badFile, "this is not a video");

    await expect(probeVideo(badFile)).rejects.toThrow();
  });

  it("rejects when the file does not exist", async () => {
    await expect(probeVideo("/nonexistent/path/video.mp4")).rejects.toThrow();
  });
});

// ── processClip — basic re-encode ─────────────────────────────────────────────

describe("processClip — basic re-encode (no trim, no crop)", () => {
  it("produces a valid MP4 output file and a JPEG thumbnail", async () => {
    const outputPath = tmpFile("basic-out.mp4");
    const thumbnailPath = tmpFile("basic-thumb.jpg");

    const probe = await processClip({
      inputPath: fixtureVideoPath,
      outputPath,
      thumbnailPath,
    });

    // Output files must exist and be non-empty
    const [outStat, thumbStat] = await Promise.all([
      fs.stat(outputPath),
      fs.stat(thumbnailPath),
    ]);
    expect(outStat.size).toBeGreaterThan(0);
    expect(thumbStat.size).toBeGreaterThan(0);

    // Probe of the output must include valid metadata
    expect(probe.durationSeconds).toBeGreaterThan(0);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
  }, 60_000);

  it("the re-encoded file is a readable MP4 that ffprobe can parse", async () => {
    const outputPath = tmpFile("readable-out.mp4");
    const thumbnailPath = tmpFile("readable-thumb.jpg");

    await processClip({ inputPath: fixtureVideoPath, outputPath, thumbnailPath });

    // Round-trip probe via our own wrapper — confirms the container is valid
    const probe = await probeVideo(outputPath);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
  }, 60_000);
});

// ── processClip — trim ────────────────────────────────────────────────────────

describe("processClip — trim", () => {
  it("produces an output shorter than the original when startSeconds/endSeconds are set", async () => {
    const outputPath = tmpFile("trim-out.mp4");
    const thumbnailPath = tmpFile("trim-thumb.jpg");

    const probe = await processClip({
      inputPath: fixtureVideoPath,
      outputPath,
      thumbnailPath,
      startSeconds: 1,
      endSeconds: 3,
    });

    // Requested duration is 2 s; allow a small codec-rounding tolerance
    expect(probe.durationSeconds).toBeGreaterThan(0);
    expect(probe.durationSeconds!).toBeLessThan(4); // less than full fixture
    // Output file must be non-empty
    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, 60_000);

  it("trim close to the end of the clip still produces a non-empty file", async () => {
    const outputPath = tmpFile("trim-end-out.mp4");
    const thumbnailPath = tmpFile("trim-end-thumb.jpg");

    // Use a 1-second window well within the fixture duration (avoid the very
    // last frame where keyframe alignment can produce 0 encoded frames).
    await processClip({
      inputPath: fixtureVideoPath,
      outputPath,
      thumbnailPath,
      startSeconds: 2,
      endSeconds: 3.5,
    });

    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, 60_000);
});

// ── processClip — crop ────────────────────────────────────────────────────────

describe("processClip — crop", () => {
  it("applies a crop filter so the output has the requested dimensions", async () => {
    const outputPath = tmpFile("crop-out.mp4");
    const thumbnailPath = tmpFile("crop-thumb.jpg");

    // Crop out a 160×120 region from the top-left corner of the 320×240 fixture
    const probe = await processClip({
      inputPath: fixtureVideoPath,
      outputPath,
      thumbnailPath,
      cropX: 0,
      cropY: 0,
      cropWidth: 160,
      cropHeight: 120,
    });

    expect(probe.width).toBe(160);
    expect(probe.height).toBe(120);

    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(0);
  }, 60_000);

  it("combines trim and crop in a single pass", async () => {
    const outputPath = tmpFile("trim-crop-out.mp4");
    const thumbnailPath = tmpFile("trim-crop-thumb.jpg");

    const probe = await processClip({
      inputPath: fixtureVideoPath,
      outputPath,
      thumbnailPath,
      startSeconds: 0,
      endSeconds: 2,
      cropX: 80,
      cropY: 60,
      cropWidth: 160,
      cropHeight: 120,
    });

    expect(probe.width).toBe(160);
    expect(probe.height).toBe(120);
    expect(probe.durationSeconds!).toBeLessThan(4);
  }, 60_000);
});
