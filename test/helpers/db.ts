import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db, Query } from "../../src/lib/db.js";

const root = join(import.meta.dirname, "..", "..", "supabase");

export const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

/** In-process Postgres with every migration (and optionally the sample seed) applied. */
export async function createTestDb(opts: { seed?: boolean } = { seed: true }): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await pg.exec(readFileSync(join(root, "migrations", f), "utf8"));
  if (opts.seed !== false) await pg.exec(readFileSync(join(root, "seed.sql"), "utf8"));
  const q = (c: { query: PGlite["query"] }): Query => ({ query: async <T>(text: string, params: unknown[] = []) => (await c.query<T>(text, params)).rows });
  const db: Db = { ...q(pg), tx: (fn) => pg.transaction((t) => fn(q(t as never))) };
  return { pg, db };
}
