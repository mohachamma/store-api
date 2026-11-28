import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import type { AdminDirectory, AdminUser } from "../src/lib/admins.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const ME = "00000000-0000-0000-0000-0000000000aa";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;

const team = new Map<string, AdminUser>([[ME, { id: ME, email: "owner@store.test", createdAt: null, lastSignInAt: null }]]);
const fakeAdmins: AdminDirectory = {
  async list() { return [...team.values()]; },
  async invite(email) { const u = { id: `u-${team.size + 1}`, email, createdAt: "2026-11-28T10:00:00.000Z", lastSignInAt: null }; team.set(u.id, u); return u; },
  async demote(id) { team.delete(id); },
};

const sign = (sub: string, claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);
const variant = async (sku: string) => (await pg.query<{ id: string }>(`select id from product_variants where sku = $1`, [sku])).rows[0]!;
const communeOf = async (w: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [w])).rows[0]!.id);
let seq = 0;
async function order(token?: string) {
  const r = await api("POST", "/orders", {
    items: [{ variantId: (await variant("HEAVY-TEE-BLACK-XL")).id, quantity: 1 }], wilayaCode: 16, deliveryType: "home",
    customer: { name: "Someone", phone: `066${String(5000000 + ++seq).slice(-7)}`, communeId: await communeOf(16), address: "12 rue des Tests" },
  }, token);
  expect(r.status).toBe(200);
  return (await pg.query<{ id: string }>(`select id from orders where order_number = $1`, [r.body.orderNumber])).rows[0]!.id;
}
async function finish(id: string, status: "delivered" | "returned") {
  await admin("POST", `/admin/orders/${id}/confirm`, { company: "manual", trackingNumber: `T-${id.slice(0, 6)}` });
  await admin("POST", `/admin/orders/${id}/status`, { status: "shipped" });
  await admin("POST", `/admin/orders/${id}/status`, { status });
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} }, admins: fakeAdmins });
  await pg.query(`update product_variants set stock = 100 where sku = 'HEAVY-TEE-BLACK-XL'`);
  adminToken = await sign(ME, { app_metadata: { role: "admin" } });
}, 60_000);
afterAll(() => pg.close());

describe("team (who can open the dashboard)", () => {
  it("needs an admin", async () => {
    expect((await api("GET", "/admin/admins")).status).toBe(401);
    expect((await api("GET", "/admin/admins", undefined, await sign("x", { app_metadata: { role: "customer" } }))).status).toBe(403);
  });
  it("lists, invites and removes", async () => {
    const list = (await admin("GET", "/admin/admins")).body;
    expect(list).toEqual([expect.objectContaining({ email: "owner@store.test", isYou: true })]);
    expect((await admin("POST", "/admin/admins", { email: "not-an-email" })).status).toBe(422);
    const inv = await admin("POST", "/admin/admins", { email: "  Staff@Store.test " });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ email: "staff@store.test", isYou: false });
    expect((await admin("GET", "/admin/admins")).body).toHaveLength(2);
    expect((await admin("DELETE", `/admin/admins/${inv.body.id}`)).status).toBe(200);
    expect((await admin("DELETE", `/admin/admins/${inv.body.id}`)).status).toBe(404);
  });
  it("never removes yourself or the last admin", async () => {
    expect((await admin("DELETE", `/admin/admins/${ME}`)).status).toBe(409);
    team.set("u-x", { id: "u-x", email: "x@store.test", createdAt: null, lastSignInAt: null });
    expect((await admin("DELETE", "/admin/admins/u-x")).status).toBe(200);
    // only the owner is left: removing "someone else" is impossible because nobody else is an admin
    expect([...team.keys()]).toEqual([ME]);
  });
});

describe("customers (CRM)", () => {
  const CUSTOMER = "11111111-1111-4111-8111-1111111111c1";
  it("lists account holders with what they spent, and counts the guests", async () => {
    await pg.query(`insert into auth.users (id) values ($1)`, [CUSTOMER]);
    const ctoken = await sign(CUSTOMER, { app_metadata: { role: "customer" }, email: "Sara@Mail.test", user_metadata: { full_name: "Sara Mehdi" } });
    expect((await api("GET", "/me", undefined, ctoken)).status).toBe(200); // creates the profile row (with the email)
    await api("PUT", "/me", { name: "Sara Mehdi", phone: "0550 12 34 56" }, ctoken);
    const a = await order(ctoken);
    const b = await order(ctoken);
    const c = await order(ctoken);
    await order(); // a guest
    const g = await order(); // another guest, delivered
    await finish(a, "delivered");
    await finish(b, "returned");
    await finish(g, "delivered");
    await admin("POST", `/admin/orders/${c}/status`, { status: "cancelled" }).catch(() => undefined);

    const r = (await admin("GET", "/admin/customers")).body;
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ id: CUSTOMER, name: "Sara Mehdi", email: "sara@mail.test", phone: "0550 12 34 56", orders: 2, delivered: 1, returned: 1 }); // the cancelled order is not counted
    expect(r.items[0].spent).toBeGreaterThan(0);
    expect(r.guests).toMatchObject({ orders: 2, delivered: 1 });
    expect((await admin("GET", "/admin/customers?q=sara")).body.total).toBe(1);
    expect((await admin("GET", "/admin/customers?q=nobody")).body.total).toBe(0);
    expect((await admin("GET", "/admin/customers?q=mail.test")).body.total).toBe(1);
  });
  it("shows one customer with orders, contact links and a private note", async () => {
    const d = (await admin("GET", `/admin/customers/${CUSTOMER}`)).body;
    expect(d).toMatchObject({ name: "Sara Mehdi", whatsappUrl: "https://wa.me/213550123456", note: "", orders: 2, delivered: 1, returned: 1 });
    expect(d.orderList).toHaveLength(3); // the list shows every order, cancelled ones included
    expect((await admin("PUT", `/admin/customers/${CUSTOMER}/note`, { note: "Prefers calls after 5pm" })).status).toBe(200);
    expect((await admin("GET", `/admin/customers/${CUSTOMER}`)).body.note).toBe("Prefers calls after 5pm");
    expect((await admin("GET", "/admin/customers")).body.items[0].hasNote).toBe(true);
    expect((await admin("GET", "/admin/customers/22222222-2222-4222-8222-2222222222ff")).status).toBe(404);
    expect((await admin("PUT", "/admin/customers/22222222-2222-4222-8222-2222222222ff/note", { note: "x" })).status).toBe(404);
  });
});
