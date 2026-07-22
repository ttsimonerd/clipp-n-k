export interface StorageDriver {
  /** Write a stream/buffer to storage under `key`. Returns nothing; throws on failure. */
  putFile(key: string, filePathOrBuffer: string | Buffer): Promise<void>;
  /** Delete an object. Should not throw if the object doesn't exist. */
  deleteFile(key: string): Promise<void>;
  /**
   * Return a URL the browser can use to fetch this object directly.
   * For local disk this is a path served by this same server; for S3 it may
   * be a public/CDN URL or a signed URL depending on bucket configuration.
   */
  getPublicUrl(key: string): string;
  /** Absolute local path to read the object from disk, if supported (used by ffmpeg during processing). */
  getLocalPath(key: string): Promise<string>;
}
