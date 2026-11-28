/**
 * Applies pending database migrations (supabase/migrations/*.sql) to the real database.
 *   npm run db:migrate
 * It runs automatically on every Vercel deploy (see vercel.json). Without a database URL it does nothing, so builds without Supabase still work.
 * URL: MIGRATIONS_DATABASE_URL if set (best: Supabase "Session pooler"), otherwise DATABASE_URL.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { applyMigrations } from "../src/lib/migrate.js";

const url = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.info("db:migrate — no DATABASE_URL set, skipping.");
  process.exit(0);
}

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ version: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") }));

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 20, onnotice: () => undefined });
try {
  const ran = await applyMigrations(
    {
      run: (q) => sql.unsafe(q),
      applied: async () => (await sql.unsafe(`select version from public.app_migrations`)).map((r) => String(r.version)),
      tx: (fn) => sql.begin((t) => fn((q) => t.unsafe(q))) as never,
    },
    files,
    (m) => console.info(`db:migrate — ${m}`),
  );
  console.info(ran.length ? `db:migrate — ${ran.length} migration(s) applied.` : "db:migrate — database is up to date.");
} catch (e) {
  // Never print the connection string or the SQL: only the database's own message.
  console.error("db:migrate FAILED:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
