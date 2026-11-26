import type { Query } from "./db.js";
import { ApiError } from "./errors.js";

const TABLES = { categories: true, collections: true } as const;

/** Moves a row one step earlier (-1) or later (+1) in its `sort_order`, renumbering 1..n first. No-op at the ends. */
export async function moveRow(q: Query, table: keyof typeof TABLES, id: string, direction: -1 | 1): Promise<void> {
  if (!TABLES[table]) throw new Error("unknown table");
  if (!(await q.query(`select 1 from public.${table} where id = $1`, [id])).length) throw new ApiError(404, "not_found", "Not found");
  await q.query(
    `with ordered as (select id, row_number() over (order by sort_order, created_at, id)::int as rn from public.${table}),
          me as (select rn from ordered where id = $1),
          tgt as (select o.id from ordered o, me where o.rn = me.rn + $2::int)
     update public.${table} t
        set sort_order = case
              when t.id = $1 and exists (select 1 from tgt) then o.rn + $2::int
              when t.id = (select id from tgt) then (select rn from me)
              else o.rn end
       from ordered o where o.id = t.id`,
    [id, direction],
  );
}
