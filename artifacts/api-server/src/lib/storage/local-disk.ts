import { promises as fs } from "node:fs";
import path from "node:path";
import type { StorageDriver } from "./types";

/**
 * Stores files on the local filesystem under `rootDir`. Default driver --
 * works out of the box in a single-container Docker/Coolify deployment as
 * long as `rootDir` is a persistent volume mount.
 */
export class LocalDiskDriver implements StorageDriver {
  private readonly rootDir: string;
  private readonly publicPathPrefix: string;

  constructor(rootDir: string, publicPathPrefix: string) {
    this.rootDir = rootDir;
    this.publicPathPrefix = publicPathPrefix;
  }

  private resolveKey(key: string): string {
    const normalized = path.normalize(key).replace(/^([./\\]+)/, "");
    const resolved = path.resolve(this.rootDir, normalized);
    if (!resolved.startsWith(path.resolve(this.rootDir))) {
      throw new Error(`Refusing to resolve storage key outside root: ${key}`);
    }
    return resolved;
  }

  async putFile(key: string, filePathOrBuffer: string | Buffer): Promise<void> {
    const dest = this.resolveKey(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (typeof filePathOrBuffer === "string") {
      await fs.copyFile(filePathOrBuffer, dest);
    } else {
      await fs.writeFile(dest, filePathOrBuffer);
    }
  }

  async deleteFile(key: string): Promise<void> {
    const target = this.resolveKey(key);
    await fs.rm(target, { force: true });
  }

  getPublicUrl(key: string): string {
    const normalized = key.replace(/^\/+/, "");
    return `${this.publicPathPrefix}/${normalized}`;
  }

  async getLocalPath(key: string): Promise<string> {
    return this.resolveKey(key);
  }
}
