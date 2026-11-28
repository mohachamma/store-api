/**
 * Applies the SQL files of supabase/migrations to a database, once each, in order.
 * Applied files are remembered in `public.app_migrations`, so running it again does nothing.
 * Each file runs in its own transaction: if one fails, nothing of it is kept and the next ones are not run.
 */
export interface MigrationFile {
  version: string; // the file name without .sql, e.g. 20261124000001_core_schema
  sql: string;
}

export interface MigrationTarget {
  /** Runs SQL that may hold several statements. */
  run(sql: string): Promise<unknown>;
  /** Versions already applied. */
  applied(): Promise<string[]>;
  tx<T>(fn: (run: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T>;
}

const TABLE = `
  create table if not exists public.app_migrations (version text primary key, applied_at timestamptz not null default now());
  alter table public.app_migrations enable row level security; -- no policies: only the owner role (the API) can read it
`;

export async function applyMigrations(target: MigrationTarget, files: MigrationFile[], log: (m: string) => void = () => undefined): Promise<string[]> {
  await target.run(TABLE);
  const done = new Set(await target.applied());
  const ran: string[] = [];
  for (const f of [...files].sort((a, b) => a.version.localeCompare(b.version))) {
    if (done.has(f.version)) continue;
    log(`applying ${f.version}`);
    await target.tx(async (run) => {
      await run(f.sql);
      await run(`insert into public.app_migrations (version) values ('${f.version.replace(/'/g, "''")}')`);
    });
    ran.push(f.version);
  }
  return ran;
}
