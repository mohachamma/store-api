import type { Db } from "./db.js";

/** Where uploaded images go (Cloudflare R2 in production, a fake in tests). */
export interface ImageStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** Hono context shared by all routes. */
export type AppEnv = { Variables: { db: Db; storage: ImageStorage; adminId?: string } };
