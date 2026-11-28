import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type MigrationTarget } from "../src/lib/migrate.js";
import { SUPABASE_STUBS } from "./helpers/db.js";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const real = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => ({ version: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") }));

async function blank() {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  const target: MigrationTarget = {
    run: (q) => pg.exec(q),
    applied: async () => (await pg.query<{ version: string }>(`select version from public.app_migrations`)).rows.map((r) => r.version),
    tx: (fn) => pg.transaction((t) => fn((q) => t.exec(q))),
  };
  return { pg, target };
}

describe("migration runner", () => {
  it("applies every migration once, in order, and then does nothing", async () => {
    const { pg, target } = await blank();
    const first = await applyMigrations(target, real);
    expect(first).toEqual(real.map((f) => f.version).sort());
    expect((await pg.query(`select count(*)::int as n from public.orders`)).rows[0]).toEqual({ n: 0 });
    expect((await pg.query(`select count(*)::int as n from public.wilayas`)).rows[0]).toEqual({ n: 58 });
    expect(await applyMigrations(target, real)).toEqual([]); // second run: nothing to do
    expect((await pg.query<{ rowsecurity: boolean }>(`select rowsecurity from pg_tables where tablename = 'app_migrations'`)).rows[0]!.rowsecurity).toBe(true);
    await pg.close();
  });

  it("a new migration is applied on the next run", async () => {
    const { pg, target } = await blank();
    await applyMigrations(target, real);
    const extra = { version: "99999999999999_extra", sql: "create table public.extra_test (id int);" };
    expect(await applyMigrations(target, [...real, extra])).toEqual(["99999999999999_extra"]);
    await pg.close();
  });

  it("a failing migration is rolled back, not recorded, and stops the run", async () => {
    const { pg, target } = await blank();
    await applyMigrations(target, real);
    const bad = { version: "99999999999998_bad", sql: "create table public.half_done (id int); select 1/0;" };
    const later = { version: "99999999999999_later", sql: "create table public.later_test (id int);" };
    await expect(applyMigrations(target, [...real, bad, later])).rejects.toThrow();
    expect((await pg.query(`select to_regclass('public.half_done') as t`)).rows[0]).toEqual({ t: null }); // nothing of the failed file is kept
    expect((await pg.query(`select to_regclass('public.later_test') as t`)).rows[0]).toEqual({ t: null }); // the next one did not run
    expect((await pg.query(`select count(*)::int as n from public.app_migrations where version like '9999%'`)).rows[0]).toEqual({ n: 0 });
    await pg.close();
  });
});
