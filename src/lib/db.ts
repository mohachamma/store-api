import postgres from "postgres";
import { getEnv } from "../env.js";
import { ApiError } from "./errors.js";

/**
 * Minimal database interface used by every route.
 * Production: a direct Postgres connection (Supabase pooler). Tests: an in-process Postgres (PGlite).
 * Always pass user input as parameters ($1, $2, ...), never concatenate it into SQL.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

let shared: Db | undefined;

/** Real connection (created on first use). Uses the service/owner role, so it bypasses RLS like the service key. */
export function getDb(): Db {
  if (shared) return shared;
  const url = getEnv().DATABASE_URL;
  if (!url) throw new ApiError(503, "service_unavailable", "Database is not configured");
  const sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });
  shared = {
    query: async <T>(text: string, params: unknown[] = []) => (await sql.unsafe(text, params as never[])) as unknown as T[],
  };
  return shared;
}

/** A Db that connects on first query, so routes that do not need the database (e.g. /health) work without it. */
export function lazyDb(resolve: () => Db = getDb): Db {
  return { query: (text, params) => resolve().query(text, params) };
}
