import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the real migrations + seed on an in-process Postgres. Supabase-specific pieces
// (roles, the auth schema, auth.jwt()) are stubbed below.
const SUPABASE_STUBS = `
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
  -- Supabase applies these default privileges to every object created in public (RLS is the real guard).
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;


const root = join(import.meta.dirname, "..", "supabase");
let db: PGlite;

/** Run a callback as a given Supabase role / JWT, then go back to the superuser. */
async function as<T>(role: "anon" | "authenticated" | "service_role", claims: object, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
  }
}
const admin = { sub: "00000000-0000-0000-0000-0000000000aa", app_metadata: { role: "admin" } };
const count = async (sql: string) => Number(((await db.query<{ n: string }>(sql)).rows[0] as { n: string }).n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(readFileSync(join(root, "migrations", f), "utf8"));
  await db.exec(readFileSync(join(root, "seed.sql"), "utf8"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe("geography", () => {
  it("has 58 wilayas and 1541 communes, every commune in a valid wilaya", async () => {
    expect(await count("select count(*) n from wilayas")).toBe(58);
    expect(await count("select count(*) n from communes")).toBe(1541);
    expect(await count("select count(distinct wilaya_code) n from communes")).toBe(58);
  });
  it("has shipping fees for every wilaya (placeholders)", async () => {
    expect(await count("select count(*) n from wilayas where home_fee > 0 and desk_fee > 0 and desk_fee <= home_fee")).toBe(58);
  });
});

describe("row level security", () => {
  it("is enabled on every table in public", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("lets anonymous visitors read only published catalog data", async () => {
    await db.exec(`insert into products (slug, name, category_id) values ('draft-item', '{"ar":"مسودة"}', (select id from categories limit 1))`);
    const slugs = await as("anon", {}, async () => (await db.query<{ slug: string }>("select slug from products")).rows.map((r) => r.slug));
    expect(slugs).toHaveLength(16);
    expect(slugs).not.toContain("draft-item");
    expect(await as("anon", {}, () => count("select count(*) n from product_variants"))).toBeGreaterThan(0);
    await db.exec(`delete from products where slug = 'draft-item'`);
  });

  it("hides orders, discount codes and events from anonymous visitors", async () => {
    for (const t of ["orders", "order_items", "discount_codes", "admin_events", "customers"]) {
      expect(await as("anon", {}, () => count(`select count(*) n from ${t}`))).toBe(0);
    }
  });

  it("hides inactive brands and exposes the brands strip settings", async () => {
    expect(await as("anon", {}, () => count("select count(*) n from brands"))).toBe(8);
    await db.exec(`update brands set is_active = false where slug = 'atlas'`);
    expect(await as("anon", {}, () => count("select count(*) n from brands"))).toBe(7);
    expect(await as("authenticated", admin, () => count("select count(*) n from brands"))).toBe(8);
    await db.exec(`update brands set is_active = true where slug = 'atlas'`);
    const strip = await as("anon", {}, async () => (await db.query<{ value: Record<string, unknown> }>(`select value from site_settings where key = 'brands_strip'`)).rows[0]?.value);
    expect(strip).toMatchObject({ enabled: true, animated: true, speed: 30, pause_on_hover: true });
  });

  it("shows offers to visitors only while active and inside their schedule", async () => {
    expect(await as("anon", {}, () => count("select count(*) n from offers"))).toBe(1);
    await db.exec(`update offers set ends_at = now() - interval '1 hour', show_countdown = false`);
    expect(await as("anon", {}, () => count("select count(*) n from offers"))).toBe(0); // expired
    expect(await as("authenticated", admin, () => count("select count(*) n from offers"))).toBe(1);
    await db.exec(`update offers set ends_at = now() + interval '7 days', is_active = false`);
    expect(await as("anon", {}, () => count("select count(*) n from offers"))).toBe(0); // switched off
    await db.exec(`update offers set is_active = true, show_countdown = true`);
    expect(await as("anon", {}, () => count("select count(*) n from offers"))).toBe(1);
    await expect(db.exec(`update offers set ends_at = null`)).rejects.toThrow(); // countdown needs an end date
  });

  it("only exposes whitelisted site settings", async () => {
    await db.exec(`insert into site_settings (key, value) values ('secret_note', '"x"')`);
    const keys = await as("anon", {}, async () => (await db.query<{ key: string }>("select key from site_settings order by key")).rows.map((r) => r.key));
    expect(keys).toEqual(["announcement", "brands_strip", "sale_page", "store_info"]);
    await db.exec(`delete from site_settings where key = 'secret_note'`);
  });

  it("does not let anonymous visitors write", async () => {
    await expect(as("anon", {}, () => db.exec(`update products set is_published = false`))).resolves.not.toThrow();
    expect(await count("select count(*) n from products where is_published")).toBe(16); // RLS filtered every row
    await expect(as("anon", {}, () => db.exec(`insert into brands (slug, name) values ('x', 'x')`))).rejects.toThrow();
  });

  it("gives admins full access based on app_metadata.role", async () => {
    expect(await as("authenticated", admin, () => count("select count(*) n from discount_codes"))).toBe(1);
    const notAdmin = { sub: "00000000-0000-0000-0000-0000000000bb", app_metadata: { role: "customer" } };
    expect(await as("authenticated", notAdmin, () => count("select count(*) n from discount_codes"))).toBe(0);
  });
});

describe("orders and privacy", () => {
  let variantId: string;
  let variantStock: number;

  async function newOrder(over: Partial<Record<string, string | number>> = {}) {
    const vals = { subtotal: 7900, shipping_fee: 700, discount_total: 0, total: 8600, ...over };
    const { rows } = await db.query<{ id: string }>(
      `insert into orders (wilaya_code, delivery_type, subtotal, shipping_fee, discount_total, total,
                           customer_name, customer_phone, commune_id, address)
       values (16, 'home', ${vals.subtotal}, ${vals.shipping_fee}, ${vals.discount_total}, ${vals.total},
               'Test Customer', '0550000000', (select id from communes where wilaya_code = 16 limit 1), '1 rue Test')
       returning id`,
    );
    const id = (rows[0] as { id: string }).id;
    await db.exec(`insert into order_items (order_id, variant_id, product_name, size, unit_price, quantity)
                   values ('${id}', '${variantId}', 'Nylon Full Zip Hoodie', 'XS', 7900, 2)`);
    return id;
  }

  beforeAll(async () => {
    const v = (await db.query<{ id: string; stock: number }>(
      `select id, stock from product_variants where sku = 'NYLON-ZIP-HOODIE-XS'`,
    )).rows[0] as { id: string; stock: number };
    variantId = v.id;
    variantStock = v.stock;
  });

  it("numbers orders from 1001 and emits an admin event without personal data", async () => {
    const id = await newOrder();
    const o = (await db.query<{ order_number: string }>(`select order_number from orders where id = '${id}'`)).rows[0] as { order_number: string };
    expect(Number(o.order_number)).toBeGreaterThanOrEqual(1001);
    const ev = (await db.query<{ payload: Record<string, unknown> }>(`select payload from admin_events where order_id = '${id}'`)).rows[0];
    expect(ev?.payload).toMatchObject({ order_number: Number(o.order_number), total: 8600, wilaya_code: 16 });
    expect(JSON.stringify(ev?.payload)).not.toMatch(/Test Customer|0550000000|rue Test/);
  });

  it("rejects inconsistent totals", async () => {
    await expect(newOrder({ total: 1 })).rejects.toThrow(/orders_total_matches/);
  });

  it("requires personal data while pending", async () => {
    await expect(
      db.exec(`insert into orders (wilaya_code, subtotal, total) values (16, 100, 100)`),
    ).rejects.toThrow(/orders_pii_pending/);
  });

  it("confirm_order stores the tracking number and erases personal data", async () => {
    const id = await newOrder();
    await as("service_role", {}, () => db.exec(`select confirm_order('${id}', 'yalidine', 'YAL-123', 'created')`));
    const o = (await db.query<Record<string, unknown>>(`select * from orders where id = '${id}'`)).rows[0] as Record<string, unknown>;
    expect(o).toMatchObject({ status: "confirmed", tracking_number: "YAL-123", delivery_company: "yalidine", wilaya_code: 16 });
    expect([o.customer_name, o.customer_phone, o.commune_id, o.address]).toEqual([null, null, null, null]);
    // cannot be confirmed twice
    await expect(db.exec(`select confirm_order('${id}', 'yalidine', 'YAL-999', 'created')`)).rejects.toThrow(/not pending/);
  });

  it("cannot move to confirmed with personal data left behind", async () => {
    const id = await newOrder();
    await expect(db.exec(`update orders set status = 'confirmed', tracking_number = 'X' where id = '${id}'`)).rejects.toThrow(/orders_pii_pending/);
  });

  it("only the service role may run order functions", async () => {
    const id = await newOrder();
    await expect(as("anon", {}, () => db.exec(`select cancel_order('${id}')`))).rejects.toThrow(/permission denied/);
    await expect(as("authenticated", admin, () => db.exec(`select cancel_order('${id}')`))).rejects.toThrow(/permission denied/);
  });

  it("cancel_order erases personal data and restores stock", async () => {
    const id = await newOrder();
    await db.exec(`update product_variants set stock = stock - 2 where id = '${variantId}'`); // what placing the order does
    await as("service_role", {}, () => db.exec(`select cancel_order('${id}')`));
    const o = (await db.query<Record<string, unknown>>(`select * from orders where id = '${id}'`)).rows[0] as Record<string, unknown>;
    expect(o.status).toBe("cancelled");
    expect([o.customer_name, o.customer_phone, o.commune_id, o.address]).toEqual([null, null, null, null]);
    const v = (await db.query<{ stock: number }>(`select stock from product_variants where id = '${variantId}'`)).rows[0] as { stock: number };
    expect(v.stock).toBe(variantStock);
  });

  it("expire_pending_orders cancels only old pending orders", async () => {
    const oldId = await newOrder();
    const freshId = await newOrder();
    await db.exec(`update orders set created_at = now() - interval '30 days' where id = '${oldId}'`);
    const n = await as("service_role", {}, async () => Number(((await db.query<{ n: number }>(`select expire_pending_orders(14) as n`)).rows[0] as { n: number }).n));
    expect(n).toBeGreaterThanOrEqual(1);
    const status = async (id: string) => ((await db.query<{ status: string }>(`select status from orders where id = '${id}'`)).rows[0] as { status: string }).status;
    expect(await status(oldId)).toBe("cancelled");
    expect(await status(freshId)).toBe("pending");
  });

  it("lets a customer read only their own orders", async () => {
    const me = "00000000-0000-0000-0000-0000000000c1";
    const other = "00000000-0000-0000-0000-0000000000c2";
    await db.exec(`insert into auth.users (id) values ('${me}'), ('${other}'); insert into customers (id) values ('${me}'), ('${other}');`);
    const id = await newOrder();
    await db.exec(`update orders set customer_id = '${me}' where id = '${id}'`);
    expect(await as("authenticated", { sub: me, app_metadata: { role: "customer" } }, () => count(`select count(*) n from orders where id = '${id}'`))).toBe(1);
    expect(await as("authenticated", { sub: other, app_metadata: { role: "customer" } }, () => count(`select count(*) n from orders where id = '${id}'`))).toBe(0);
  });
});

describe("catalog constraints", () => {
  it("rejects a compare-at price that is not higher than the price", async () => {
    await expect(
      db.exec(`insert into product_variants (product_id, size, price, compare_at_price)
               values ((select id from products limit 1), 'XXL', 5000, 4000)`),
    ).rejects.toThrow();
  });
  it("rejects negative stock and non-positive prices", async () => {
    const pid = `(select id from products limit 1)`;
    await expect(db.exec(`insert into product_variants (product_id, size, stock, price) values (${pid}, 'S2', -1, 100)`)).rejects.toThrow();
    await expect(db.exec(`insert into product_variants (product_id, size, stock, price) values (${pid}, 'S3', 1, 0)`)).rejects.toThrow();
  });
  it("requires an Arabic name", async () => {
    await expect(db.exec(`insert into categories (slug, name) values ('x1', '{"fr":"seulement"}')`)).rejects.toThrow();
  });
  it("validates discount codes", async () => {
    await expect(db.exec(`insert into discount_codes (code, kind, value) values ('lower', 'percent', 10)`)).rejects.toThrow();
    await expect(db.exec(`insert into discount_codes (code, kind, value) values ('BIG', 'percent', 150)`)).rejects.toThrow();
  });
  it("seeds a coherent sample catalog", async () => {
    expect(await count("select count(*) n from products")).toBe(16);
    expect(await count("select count(*) n from product_images")).toBe(48);
    expect(await count("select count(*) n from looks")).toBe(4);
    expect(await count("select count(*) n from look_products")).toBe(8);
    expect(await count("select count(*) n from collection_products")).toBe(16);
    expect(await count("select count(*) n from products p where not exists (select 1 from product_variants v where v.product_id = p.id)")).toBe(0);
  });
});
