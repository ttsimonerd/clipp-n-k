import path from "node:path";
import type { StorageDriver } from "./types";
import { LocalDiskDriver } from "./local-disk";
import { S3Driver } from "./s3";

let driver: StorageDriver | undefined;

/**
 * Selects the storage driver via the STORAGE_DRIVER env var so self-hosted
 * deployments can swap local disk for S3/MinIO/R2 without code changes.
 *   STORAGE_DRIVER=local (default) -- STORAGE_LOCAL_DIR (default ./data/uploads)
 *   STORAGE_DRIVER=s3              -- S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID,
 *                                      S3_SECRET_ACCESS_KEY, S3_ENDPOINT (optional),
 *                                      S3_FORCE_PATH_STYLE (optional "true"/"false"),
 *                                      S3_PUBLIC_BASE_URL (optional)
 */
export function getStorageDriver(): StorageDriver {
  if (driver) {
    return driver;
  }

  const kind = process.env.STORAGE_DRIVER ?? "local";

  if (kind === "s3") {
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION ?? "auto";
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to be set.",
      );
    }
    driver = new S3Driver({
      bucket,
      region,
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
    });
    return driver;
  }

  const rootDir =
    process.env.STORAGE_LOCAL_DIR ??
    path.resolve(process.cwd(), "data", "uploads");
  driver = new LocalDiskDriver(rootDir, "/api/files");
  return driver;
}
