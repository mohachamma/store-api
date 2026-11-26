/**
 * Full local environment for the API — no Supabase, no Cloudflare, no secrets needed.
 *   npm run dev:local
 *
 * - Postgres in memory (PGlite) with every migration and the sample seed
 * - a tiny fake Supabase Auth (POST /auth/v1/token) issuing real HS256 tokens
 * - a fake image bucket (uploads are kept in memory and served back from /img/*)
 * Demo logins: admin@store.test / admin1234 (admin) and customer@store.test / customer1234.
 * Data resets whenever the process restarts. Never use this in production.
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { SignJWT } from "jose";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import { manualProvider } from "../src/lib/delivery/index.js";
import { chargily } from "../src/lib/payments/chargily.js";
import { createTestDb } from "../test/helpers/db.js";

const API_PORT = Number(process.env.PORT ?? 8787);
const FAKE_PORT = Number(process.env.FAKE_SERVICES_PORT ?? 54321);
const SECRET = "local-dev-secret-local-dev-secret-0000";

Object.assign(process.env, {
  NODE_ENV: "development",
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  ADMIN_ORIGIN: process.env.ADMIN_ORIGIN ?? "http://localhost:3001",
  SUPABASE_URL: `http://localhost:${FAKE_PORT}`,
  SUPABASE_ANON_KEY: "local-anon-key",
  SUPABASE_JWT_SECRET: SECRET,
  R2_PUBLIC_URL: `http://localhost:${FAKE_PORT}/img`,
  CHARGILY_SECRET_KEY: "local-dev-chargily-secret",
  PUBLIC_API_URL: `http://localhost:${API_PORT}`,
});

const users: Record<string, { id: string; password: string; role: "admin" | "customer"; name?: string }> = {
  "admin@store.test": { id: "00000000-0000-0000-0000-0000000000a1", password: "admin1234", role: "admin" },
  "customer@store.test": { id: "00000000-0000-0000-0000-0000000000c1", password: "customer1234", role: "customer" },
};

let pgRef: { query: (sql: string, params?: unknown[]) => Promise<unknown> } | undefined;
const images = new Map<string, { bytes: Uint8Array; type: string }>();

// Fake Supabase Auth + fake image bucket
createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${FAKE_PORT}`);
  if (req.method === "POST" && url.pathname === "/auth/v1/token") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const { email, password } = JSON.parse(raw || "{}") as { email?: string; password?: string };
      const u = email ? users[email.toLowerCase()] : undefined;
      res.setHeader("Content-Type", "application/json");
      if (!u || u.password !== password) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
      }
      const app_metadata = { role: u.role };
      const token = await new SignJWT({ app_metadata, email, user_metadata: u.name ? { full_name: u.name } : {} })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(u.id)
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(new TextEncoder().encode(SECRET));
      res.end(JSON.stringify({ access_token: token, expires_in: 8 * 3600, user: { id: u.id, email, app_metadata } }));
    });
    return;
  }
  // Fake sign-up: creates a customer (no email confirmation locally) and returns a session like Supabase does.
  if (req.method === "POST" && url.pathname === "/auth/v1/signup") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const { email, password, data } = JSON.parse(raw || "{}") as { email?: string; password?: string; data?: { full_name?: string } };
      res.setHeader("Content-Type", "application/json");
      const key = (email ?? "").toLowerCase();
      if (users[key]) {
        res.statusCode = 422;
        return res.end(JSON.stringify({ error_code: "user_already_exists", msg: "User already registered" }));
      }
      const id = crypto.randomUUID();
      users[key] = { id, password: password ?? "", role: "customer", name: data?.full_name };
      await pgRef?.query(`insert into auth.users (id) values ($1)`, [id]);
      const token = await new SignJWT({ app_metadata: { role: "customer" }, user_metadata: data ?? {}, email: key })
        .setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
      res.end(JSON.stringify({ access_token: token, expires_in: 8 * 3600, user: { id, email: key } }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/img/")) {
    const obj = images.get(decodeURIComponent(url.pathname.slice(5)));
    if (!obj) return void ((res.statusCode = 404), res.end());
    res.setHeader("Content-Type", obj.type);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return void res.end(Buffer.from(obj.bytes));
  }
  // Fake Chargily checkout page: "paying" sends the same signed webhook the real service would, then returns to the shop.
  if (req.method === "GET" && url.pathname.startsWith("/pay/")) {
    const ref = decodeURIComponent(url.pathname.slice(5));
    const body = JSON.stringify({ type: url.searchParams.get("fail") ? "checkout.failed" : "checkout.paid", data: { id: ref } });
    const signature = createHmac("sha256", process.env.CHARGILY_SECRET_KEY!).update(body).digest("hex");
    void fetch(`http://localhost:${API_PORT}/webhooks/chargily`, { method: "POST", headers: { "content-type": "application/json", signature }, body }).then(() => {
      res.statusCode = 302;
      res.setHeader("Location", url.searchParams.get("return") ?? "/");
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(FAKE_PORT);

// Fake delivery company ("yalidine" in the dashboard list) so confirming an order can be tried without real keys.
const fakeYalidine = { id: "yalidine", name: "Yalidine (local fake)", configured: () => true, async createParcel(i: { orderNumber: number }) { return { trackingNumber: `YAL-LOCAL-${i.orderNumber}`, status: "created" }; }, async getTracking() { return { status: "in_transit" }; }, async cancelParcel() {} };
const realChargily = chargily();
// Same signature checking as production; only the checkout page is fake.
const fakePay = { ...realChargily, configured: () => true, async createCheckout(i: { orderNumber: number; token: string; locale: string }) {
  const back = `${process.env.WEB_ORIGIN!.split(",")[0]}/${i.locale}/order/${i.orderNumber}?t=${i.token}`;
  return { ref: `local_${i.orderNumber}`, checkoutUrl: `http://localhost:${FAKE_PORT}/pay/local_${i.orderNumber}?return=${encodeURIComponent(back)}` };
} };

const { db, pg } = await createTestDb();
pgRef = pg;
await pg.query(`insert into auth.users (id) values ($1)`, [users["customer@store.test"]!.id]);
const app = createApp({ db, delivery: { manual: manualProvider, yalidine: fakeYalidine }, payment: fakePay, storage: { upload: async (key, bytes, type) => void images.set(key, { bytes, type }) } });

serve({ fetch: app.fetch, port: API_PORT }, () => {
  console.info(`store-api (local, in-memory) on http://localhost:${API_PORT}  — fake auth/images on :${FAKE_PORT}`);
  console.info("Admin login: admin@store.test / admin1234");
});
