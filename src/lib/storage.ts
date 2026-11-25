import { AwsClient } from "aws4fetch";
import { getEnv } from "../env.js";
import { ApiError } from "./errors.js";
import type { ImageStorage } from "./types.js";

/**
 * Production image storage: Cloudflare R2 through its S3-compatible API (SigV4, region "auto").
 * Objects get a random key, so they can be cached forever.
 */
export function createR2Storage(fetchImpl: typeof fetch = fetch): ImageStorage {
  return {
    async upload(key, bytes, contentType) {
      const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = getEnv();
      if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        throw new ApiError(503, "service_unavailable", "Image storage is not configured");
      }
      const aws = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: "s3", region: "auto", retries: 0 });
      const url = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
      const signed = await aws.sign(url, {
        method: "PUT",
        body: bytes as BodyInit,
        headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" },
      });
      const res = await fetchImpl(signed);
      if (!res.ok) {
        console.error("R2 upload failed:", res.status);
        throw new ApiError(502, "storage_error", "Could not store the image");
      }
    },
  };
}

export const r2Storage = createR2Storage();
