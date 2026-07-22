import ffmpeg from "fluent-ffmpeg";
import { logger } from "./logger";

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export function probeVideo(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      const videoStream = data.streams.find((s) => s.codec_type === "video");
      resolve({
        durationSeconds: data.format.duration ?? null,
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
      });
    });
  });
}

export interface ProcessClipOptions {
  inputPath: string;
  outputPath: string;
  thumbnailPath: string;
  startSeconds?: number;
  endSeconds?: number;
  cropX?: number | null;
  cropY?: number | null;
  cropWidth?: number | null;
  cropHeight?: number | null;
}

/**
 * Trims (optional), crops (optional) and compresses a video with ffmpeg, and
 * extracts a thumbnail frame. Resolves with the probed output metadata.
 */
export function processClip(options: ProcessClipOptions): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(options.inputPath);

    if (
      options.startSeconds !== undefined &&
      options.endSeconds !== undefined
    ) {
      const duration = Math.max(0, options.endSeconds - options.startSeconds);
      command.setStartTime(options.startSeconds).setDuration(duration);
    }

    const filters: string[] = [];
    if (
      options.cropWidth != null &&
      options.cropHeight != null &&
      options.cropX != null &&
      options.cropY != null
    ) {
      filters.push(
        `crop=${options.cropWidth}:${options.cropHeight}:${options.cropX}:${options.cropY}`,
      );
    }

    if (filters.length > 0) {
      command.videoFilters(filters);
    }

    command
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-crf", "28", "-preset", "veryfast", "-movflags", "+faststart"])
      .on("error", (err) => {
        logger.error({ err }, "ffmpeg processing failed");
        reject(err);
      })
      .on("end", async () => {
        try {
          await extractThumbnail(options.outputPath, options.thumbnailPath);
          const probe = await probeVideo(options.outputPath);
          resolve(probe);
        } catch (err) {
          reject(err);
        }
      })
      .save(options.outputPath);
  });
}

function extractThumbnail(
  videoPath: string,
  thumbnailPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on("error", (err) => reject(err))
      .on("end", () => resolve())
      .screenshots({
        timestamps: ["1"],
        filename: require("node:path").basename(thumbnailPath),
        folder: require("node:path").dirname(thumbnailPath),
        size: "480x?",
      });
  });
}
