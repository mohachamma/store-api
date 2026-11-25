import type { Db } from "./db.js";

/** Hono context shared by all routes. */
export type AppEnv = { Variables: { db: Db; adminId?: string } };
