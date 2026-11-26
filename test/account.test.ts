import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
const ALICE = "00000000-0000-0000-0000-0000000000a1";
const BOB = "00000000-0000-0000-0000-0000000000b2";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
const tokenFor = (sub: string, extra: Record<string, unknown> = {}) =>
  new SignJWT({ email: `${sub.slice(-2)}@x.test`, ...extra }).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
let alice: string, bob: string;

async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const product = async (slug: string) => (await pg.query<{ id: string }>(`select id from products where slug = $1`, [slug])).rows[0]!.id;
const variant = async (sku: string) => (await pg.query<{ id: string }>(`select id from product_variants where sku = $1`, [sku])).rows[0]!.id;
const communeOf = async (w: number) => Number((await pg.query<{ id: number }>(`select id from communes where wilaya_code = $1 order by id limit 1`, [w])).rows[0]!.id);

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  process.env.SUPABASE_URL = "https://auth.example.com";
  process.env.SUPABASE_ANON_KEY = "anon";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  await pg.query(`insert into auth.users (id) values ($1), ($2)`, [ALICE, BOB]);
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  alice = await tokenFor(ALICE, { user_metadata: { full_name: "Alice Benali" } });
  bob = await tokenFor(BOB);
}, 60_000);
afterAll(() => pg.close());
afterEach(() => vi.unstubAllGlobals());

describe("customer accounts", () => {
  it("needs a signed-in user", async () => {
    expect((await api("GET", "/me")).status).toBe(401);
    expect((await api("GET", "/me/favorites")).status).toBe(401);
    expect((await api("GET", "/me/orders", undefined, "garbage")).status).toBe(401);
  });

  it("creates the profile on first use, with the name given at registration", async () => {
    const r = await api("GET", "/me", undefined, alice);
    expect(r.body).toMatchObject({ id: ALICE, name: "Alice Benali", phone: null });
    const u = await api("PUT", "/me", { name: "Alice B.", phone: "0550123456" }, alice);
    expect(u.body).toMatchObject({ name: "Alice B.", phone: "0550123456" });
    expect((await api("GET", "/me", undefined, bob)).body.name).toBeNull();
  });

  it("favorites: add, list, merge guest favorites, remove — each customer sees only their own", async () => {
    const tee = await product("heavy-tee-cream"), coat = await product("hooded-deck-coat");
    expect((await api("PUT", `/me/favorites/${tee}`, undefined, alice)).status).toBe(200);
    expect((await api("PUT", `/me/favorites/${tee}`, undefined, alice)).status).toBe(200); // idempotent
    const merged = await api("POST", "/me/favorites/merge?locale=fr", { productIds: [tee, coat, "00000000-0000-0000-0000-000000000000"] }, alice);
    expect(merged.body.ids.sort()).toEqual([tee, coat].sort());
    expect(merged.body.products[0]).toHaveProperty("price");
    expect((await api("GET", "/me/favorites", undefined, bob)).body.ids).toEqual([]);
    expect((await api("DELETE", `/me/favorites/${tee}`, undefined, alice)).status).toBe(200);
    expect((await api("GET", "/me/favorites", undefined, alice)).body.ids).toEqual([coat]);
    expect((await api("PUT", "/me/favorites/00000000-0000-0000-0000-000000000000", undefined, alice)).status).toBe(404);
  });

  it("an order placed while signed in appears in the customer's history, without personal data; guests' orders do not", async () => {
    const v = await variant("HEAVY-TEE-CREAM-M"), cm = await communeOf(16);
    const send = (token?: string, phone = "0550123456") => api("POST", "/orders", { items: [{ variantId: v, quantity: 1 }], wilayaCode: 16, deliveryType: "home", customer: { name: "Alice Benali", phone, communeId: cm, address: "12 rue des Tests" } }, token);
    const mine = await send(alice);
    const guest = await send(undefined, "0550999888");
    const bad = await send("not-a-token", "0550777666"); // an invalid token never blocks checkout
    expect([mine.status, guest.status, bad.status]).toEqual([200, 200, 200]);
    const list = await api("GET", "/me/orders", undefined, alice);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ orderNumber: mine.body.orderNumber, token: mine.body.token, status: "pending", paymentMethod: "cod" });
    expect(JSON.stringify(list.body)).not.toMatch(/Alice|0550123456|rue des Tests/);
    expect((await api("GET", "/me/orders", undefined, bob)).body).toEqual([]);
    // the token from the history opens the customer's order page
    expect((await api("GET", `/orders/${mine.body.orderNumber}?token=${list.body[0].token}`)).status).toBe(200);
  });

  it("deleting the account (Supabase user) removes favorites and unlinks orders but keeps the order", async () => {
    await pg.query(`delete from public.customers where id = $1`, [ALICE]);
    expect((await pg.query(`select count(*)::int as n from orders where customer_id is null`)).rows[0]).toMatchObject({ n: expect.any(Number) });
    expect((await pg.query(`select count(*)::int as n from favorites where customer_id = $1`, [ALICE])).rows[0]).toEqual({ n: 0 });
  });
});

describe("registration", () => {
  const reg = (b: Record<string, unknown>) => api("POST", "/auth/register", { email: "new@x.test", password: "longpassword1", ...b });
  it("creates a customer account and returns a session when no email confirmation is needed", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, user: { id: ALICE, email: "new@x.test" } }));
    });
    const r = await reg({ name: "Nadia Haddad" });
    expect(r.body).toEqual({ confirmationRequired: false, session: { accessToken: "tok", expiresIn: 3600, user: { id: ALICE, email: "new@x.test", role: "customer" } } });
    expect(calls[0]!.url).toBe("https://auth.example.com/auth/v1/signup");
    // the name goes to user_metadata only; no role can be requested by the client
    expect(calls[0]!.body).toEqual({ email: "new@x.test", password: "longpassword1", data: { full_name: "Nadia Haddad" } });
    expect((await reg({ role: "admin" })).status).toBe(200);
    expect(calls[1]!.body).not.toHaveProperty("role");
  });

  it("asks for email confirmation when Supabase sends no session", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: BOB, email: "new@x.test" })));
    expect((await reg({})).body).toEqual({ confirmationRequired: true, session: null });
  });

  it("reports an email that is already registered, and short passwords", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error_code: "user_already_exists", msg: "User already registered" }), { status: 422 }));
    expect((await reg({})).status).toBe(409);
    expect((await api("POST", "/auth/register", { email: "a@x.test", password: "short" })).status).toBe(422);
  });
});
