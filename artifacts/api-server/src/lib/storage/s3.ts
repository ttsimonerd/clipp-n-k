import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { StorageDriver } from "./types";

interface S3DriverOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
}

/**
 * S3-compatible driver -- works against AWS S3 or any S3-compatible target
 * (MinIO, Cloudflare R2, Backblaze B2, etc.) by pointing `endpoint` at it.
 */
export class S3Driver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | undefined;

  constructor(options: S3DriverOptions) {
    this.bucket = options.bucket;
    this.publicBaseUrl = options.publicBaseUrl;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async putFile(key: string, filePathOrBuffer: string | Buffer): Promise<void> {
    const body =
      typeof filePathOrBuffer === "string"
        ? await fs.readFile(filePathOrBuffer)
        : filePathOrBuffer;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async deleteFile(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  getPublicUrl(key: string): string {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
    }
    return `/api/storage/${key}`;
  }

  async getLocalPath(key: string): Promise<string> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const tmpPath = path.join(os.tmpdir(), `clippnk-${Date.now()}-${path.basename(key)}`);
    const body = response.Body;
    if (!body) {
      throw new Error(`S3 object has no body: ${key}`);
    }
    const chunks: Buffer[] = [];
    // @ts-expect-error -- Body is a Node Readable in the node runtime
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    await fs.writeFile(tmpPath, Buffer.concat(chunks));
    return tmpPath;
  }
}
