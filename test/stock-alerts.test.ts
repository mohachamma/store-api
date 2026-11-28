import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let token: string;

async function api(method: string, path: string, json?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  token = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("sold-out colors and sizes are visible to the owner", () => {
  it("shows which color + size combinations ran out, in the product list and the overview", async () => {
    const rows = (await pg.query<{ id: string; color: string; size: string }>(`select v.id, v.color, v.size from product_variants v join products p on p.id = v.product_id where p.slug = 'heavy-tee-cream' order by v.color, v.size`)).rows;
    const black = rows.filter((r) => r.color.toLowerCase() === "black");
    expect(black.length).toBeGreaterThanOrEqual(2);
    const [a, b] = black;
    expect((await api("POST", "/admin/variants/bulk", { updates: [{ variantId: a!.id, stock: 0 }, { variantId: b!.id, stock: 0 }] })).status).toBe(200);

    const list = (await api("GET", "/admin/products?q=heavy-tee-cream")).body.items.find((p: { slug: string }) => p.slug === "heavy-tee-cream");
    expect(list.soldOut).toEqual(expect.arrayContaining([{ color: a!.color, size: a!.size }, { color: b!.color, size: b!.size }]));
    expect(list.soldOut.every((x: { color: string }) => x.color.toLowerCase() === "black")).toBe(true);

    const low = (await api("GET", "/admin/stats/overview")).body.lowStock;
    expect(low.filter((x: { color: string; stock: number }) => x.stock === 0 && x.color.toLowerCase() === "black").length).toBeGreaterThanOrEqual(1);

    // A customer can no longer order a sold-out combination.
    const order = await app.request("/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ variantId: a!.id, quantity: 1 }], wilayaCode: 16, deliveryType: "home",
        customer: { name: "Test", phone: "0550123456", communeId: Number((await pg.query(`select id from communes where wilaya_code = 16 limit 1`)).rows[0]!.id), address: "Rue 1" },
      }),
    });
    expect([409, 422]).toContain(order.status);
  });
});
