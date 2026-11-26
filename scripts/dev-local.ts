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
import { createApp } from "../src/app.js";
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
});

const users: Record<string, { id: string; password: string; role: "admin" | "customer" }> = {
  "admin@store.test": { id: "00000000-0000-0000-0000-0000000000a1", password: "admin1234", role: "admin" },
  "customer@store.test": { id: "00000000-0000-0000-0000-0000000000c1", password: "customer1234", role: "customer" },
};

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
      const token = await new SignJWT({ app_metadata, email })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(u.id)
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(new TextEncoder().encode(SECRET));
      res.end(JSON.stringify({ access_token: token, expires_in: 8 * 3600, user: { id: u.id, email, app_metadata } }));
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
  res.statusCode = 404;
  res.end();
}).listen(FAKE_PORT);

const { db } = await createTestDb();
const app = createApp({ db, storage: { upload: async (key, bytes, type) => void images.set(key, { bytes, type }) } });

serve({ fetch: app.fetch, port: API_PORT }, () => {
  console.info(`store-api (local, in-memory) on http://localhost:${API_PORT}  — fake auth/images on :${FAKE_PORT}`);
  console.info("Admin login: admin@store.test / admin1234");
});
