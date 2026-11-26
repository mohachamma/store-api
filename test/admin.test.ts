import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
const uploads: { path: string; type: string; size: number }[] = [];

const token = (role: string | null, opts: { exp?: string; secret?: string } = {}) =>
  new SignJWT({ app_metadata: role ? { role } : {}, email: "x@y.dz" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("00000000-0000-0000-0000-0000000000aa")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));

async function call(method: string, path: string, opts: { token?: string | null; json?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? (await token("admin"))}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.json); }
  if (opts.form) body = opts.form;
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async (path, bytes, type) => void uploads.push({ path, type, size: bytes.length }) } });
}, 60_000);
afterAll(() => pg.close());

describe("admin authentication", () => {
  it("rejects missing, malformed, expired, wrongly signed and non-admin tokens", async () => {
    expect((await call("GET", "/admin/brands", { token: null })).status).toBe(401);
    expect((await call("GET", "/admin/brands", { token: "not.a.jwt" })).status).toBe(401);
    expect((await call("GET", "/admin/brands", { token: await token("admin", { exp: "-1h" }) })).status).toBe(401);
    expect((await call("GET", "/admin/brands", { token: await token("admin", { secret: "another-secret-another-secret-123456" }) })).status).toBe(401);
    expect((await call("GET", "/admin/brands", { token: await token("customer") })).status).toBe(403);
    expect((await call("GET", "/admin/brands", { token: await token(null) })).status).toBe(403);
    expect((await call("GET", "/admin/brands")).status).toBe(200);
  });
  it("protects every admin route", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    const adminPaths = Object.keys(doc.paths).filter((p) => p.startsWith("/admin"));
    expect(adminPaths.length).toBeGreaterThanOrEqual(9);
    for (const p of adminPaths) {
      const res = await app.request(p.replace("{id}", "00000000-0000-0000-0000-000000000001"), { method: "GET" });
      expect(res.status, p).toBe(401);
    }
  });
});

describe("brands", () => {
  it("creates, edits, hides, reorders and deletes — and the storefront follows", async () => {
    const created = await call("POST", "/admin/brands", { json: { name: "Dunes", logoUrl: "/placeholders/brands/atlas.svg", href: "/search?q=dunes", isActive: true } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "Dunes", href: "/search?q=dunes", isActive: true });
    const id = created.body.id as string;

    const list = async () => (await call("GET", "/admin/brands")).body.map((b: { name: string }) => b.name);
    expect((await list()).at(-1)).toBe("Dunes");

    await call("POST", `/admin/brands/${id}/move`, { json: { direction: -1 } });
    expect((await list()).slice(-2)).toEqual(["Dunes", "SAHARI"]);
    await call("POST", `/admin/brands/${id}/move`, { json: { direction: 1 } });
    expect((await list()).at(-1)).toBe("Dunes");
    await call("POST", `/admin/brands/${id}/move`, { json: { direction: 1 } }); // already last: no-op
    expect((await list()).at(-1)).toBe("Dunes");

    // public strip shows it in that order; hiding removes it
    expect(((await (await app.request("/catalog/brands")).json()) as { name: string }[]).at(-1)?.name).toBe("Dunes");
    await call("PUT", `/admin/brands/${id}`, { json: { name: "Dunes", logoUrl: null, href: null, isActive: false } });
    expect(((await (await app.request("/catalog/brands")).json()) as { name: string }[]).map((b) => b.name)).not.toContain("Dunes");
    expect((await call("GET", "/admin/brands")).body.some((b: { name: string }) => b.name === "Dunes")).toBe(true);

    expect((await call("DELETE", `/admin/brands/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/brands/${id}`)).status).toBe(404);
    expect((await call("POST", `/admin/brands/${id}/move`, { json: { direction: 1 } })).status).toBe(404);
  });

  it("validates input", async () => {
    expect((await call("POST", "/admin/brands", { json: { name: "" } })).status).toBe(422);
    expect((await call("POST", "/admin/brands", { json: { name: "X", href: "javascript:alert(1)" } })).status).toBe(422);
    expect((await call("POST", "/admin/brands", { json: { name: "X", logoUrl: "data:image/png;base64,AAAA" } })).status).toBe(422);
    expect((await call("PUT", "/admin/brands/not-a-uuid", { json: { name: "X" } })).status).toBe(422);
  });
});

describe("brands strip settings", () => {
  it("saves animation controls and the storefront reads them", async () => {
    const put = await call("PUT", "/admin/brands-strip", { json: { enabled: true, animated: false, speed: 45, pauseOnHover: false, title: { ar: "شركاؤنا", fr: "Partenaires", en: "" } } });
    expect(put.status).toBe(200);
    expect((await call("GET", "/admin/brands-strip")).body).toEqual({ enabled: true, animated: false, speed: 45, pauseOnHover: false, title: { ar: "شركاؤنا", fr: "Partenaires", en: "" } });
    const home = (await (await app.request("/catalog/home?locale=fr")).json()) as { brandsStrip: unknown };
    expect(home.brandsStrip).toEqual({ enabled: true, animated: false, speed: 45, pauseOnHover: false, title: "Partenaires" });
    expect((await call("PUT", "/admin/brands-strip", { json: { enabled: true, animated: true, speed: 500, pauseOnHover: true, title: { ar: "x" } } })).status).toBe(422);
    expect((await call("PUT", "/admin/brands-strip", { json: { enabled: true, animated: true, speed: 30, pauseOnHover: true, title: { ar: "" } } })).status).toBe(422);
  });
});

describe("offers", () => {
  const base = { title: { ar: "تخفيضات الشتاء", fr: "Soldes", en: "" }, ctaLabel: { ar: "تسوّق", fr: "", en: "" }, href: "/sale", theme: "light" as const };

  it("creates a scheduled offer that appears in the storefront only inside its window", async () => {
    const future = new Date(Date.now() + 2 * 86400_000).toISOString();
    const created = await call("POST", "/admin/offers", { json: { ...base, startsAt: future, endsAt: new Date(Date.now() + 5 * 86400_000).toISOString(), showCountdown: true } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ theme: "light", showCountdown: true, isActive: true });
    const publicTitles = async () => ((await (await app.request("/catalog/home")).json()) as { offers: { title: string }[] }).offers.map((o) => o.title);
    expect(await publicTitles()).not.toContain("تخفيضات الشتاء"); // scheduled for later

    const id = created.body.id as string;
    await call("PUT", `/admin/offers/${id}`, { json: { ...base, startsAt: null, endsAt: new Date(Date.now() + 86400_000).toISOString(), showCountdown: true } });
    expect(await publicTitles()).toContain("تخفيضات الشتاء");
    const offer = ((await (await app.request("/catalog/home?locale=fr")).json()) as { offers: { title: string; countdownEndsAt: string | null; ctaLabel: string | null }[] }).offers.find((o) => o.title === "Soldes");
    expect(offer?.countdownEndsAt).toBeTruthy();
    expect(offer?.ctaLabel).toBe("تسوّق"); // falls back to Arabic

    await call("PUT", `/admin/offers/${id}`, { json: { ...base, isActive: false } });
    expect(await publicTitles()).not.toContain("تخفيضات الشتاء");
    expect((await call("DELETE", `/admin/offers/${id}`)).status).toBe(200);
    expect((await call("DELETE", `/admin/offers/${id}`)).status).toBe(404);
  });

  it("validates schedule and countdown rules", async () => {
    expect((await call("POST", "/admin/offers", { json: { ...base, showCountdown: true } })).status).toBe(422);
    const a = new Date(Date.now() + 86400_000).toISOString();
    const b = new Date(Date.now() + 3600_000).toISOString();
    expect((await call("POST", "/admin/offers", { json: { ...base, startsAt: a, endsAt: b } })).status).toBe(422);
    expect((await call("POST", "/admin/offers", { json: { ...base, title: { ar: "" } } })).status).toBe(422);
    expect((await call("POST", "/admin/offers", { json: { ...base, href: "//evil.example" } })).status).toBe(422);
  });
});

describe("site content and sale page", () => {
  it("changes the announcement bar and hides it when empty", async () => {
    await call("PUT", "/admin/site", { json: { announcement: { ar: "خصم 20% هذا الأسبوع", fr: "", en: "20% off this week" } } });
    expect((await call("GET", "/admin/site")).body.announcement.en).toBe("20% off this week");
    expect(((await (await app.request("/catalog/site?locale=en")).json()) as { announcement: string }).announcement).toBe("20% off this week");
    expect(((await (await app.request("/catalog/site?locale=fr")).json()) as { announcement: string }).announcement).toBe("خصم 20% هذا الأسبوع");
    await call("PUT", "/admin/site", { json: { announcement: { ar: "", fr: "", en: "" } } });
    expect(((await (await app.request("/catalog/site")).json()) as { announcement: unknown }).announcement).toBeNull();
  });

  it("edits the sale page title and can switch it off", async () => {
    await call("PUT", "/admin/sale-page", { json: { enabled: false, title: { ar: "عروض", fr: "", en: "Deals" }, subtitle: { ar: "", fr: "", en: "" } } });
    const sale = (await (await app.request("/catalog/sale?locale=en")).json()) as { enabled: boolean; title: string; subtitle: string | null };
    expect(sale).toMatchObject({ enabled: false, title: "Deals", subtitle: null });
  });
});

describe("uploads", () => {
  const form = (file: File) => { const f = new FormData(); f.append("file", file); return f; };
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
  it("stores a valid image using its real type and returns its public URL", async () => {
    const r = await call("POST", "/admin/uploads", { form: form(new File([PNG], "logo.png", { type: "image/png" })) });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/^https:\/\/img\.example\.com\/uploads\/\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
    expect(uploads.at(-1)).toMatchObject({ type: "image/png", size: PNG.length });
    // the dashboard sends that URL back when saving: only the key is stored
    const b = await call("POST", "/admin/brands", { json: { name: "WithLogo", logoUrl: r.body.url } });
    expect(b.body.logoUrl).toBe(r.body.url);
    const row = (await pg.query<{ logo_path: string }>(`select logo_path from brands where name = 'WithLogo'`)).rows[0];
    expect(row?.logo_path).toMatch(/^uploads\//);
  });
  it("accepts the WebP the dashboard produces, whatever the declared type says", async () => {
    const r = await call("POST", "/admin/uploads", { form: form(new File([WEBP], "photo.bin", { type: "application/octet-stream" })) });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(/\.webp$/);
    expect(uploads.at(-1)?.type).toBe("image/webp");
  });
  it("rejects fake images (HTML or SVG renamed), SVG, empty and oversized files, and a missing field", async () => {
    const before = uploads.length;
    expect((await call("POST", "/admin/uploads", { form: form(new File(["<script>alert(1)</script>"], "x.png", { type: "image/png" })) })).status).toBe(422);
    expect((await call("POST", "/admin/uploads", { form: form(new File(['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'], "x.svg", { type: "image/svg+xml" })) })).status).toBe(422);
    expect((await call("POST", "/admin/uploads", { form: form(new File([], "e.png", { type: "image/png" })) })).status).toBe(422);
    expect((await call("POST", "/admin/uploads", { form: form(new File([PNG, new Uint8Array(3 * 1024 * 1024)], "big.png", { type: "image/png" })) })).status).toBe(422);
    expect((await call("POST", "/admin/uploads", { form: new FormData() })).status).toBe(422);
    expect(uploads.length).toBe(before);
  });
});

describe("login", () => {
  it("maps Supabase responses and never leaks details", async () => {
    process.env.SUPABASE_ANON_KEY = "anon-key";
    resetEnvCache();
    const ok = { access_token: "tok", expires_in: 3600, user: { id: "u1", email: "a@b.dz", app_metadata: { role: "admin" } } };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }));
    const good = await call("POST", "/auth/login", { token: null, json: { email: "a@b.dz", password: "pw" } });
    expect(good).toMatchObject({ status: 200, body: { accessToken: "tok", expiresIn: 3600, user: { id: "u1", email: "a@b.dz", role: "admin" } } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://example.supabase.co/auth/v1/token?grant_type=password");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    expect((await call("POST", "/auth/login", { token: null, json: { email: "a@b.dz", password: "bad" } })).body).toEqual({ error: { code: "invalid_credentials", message: "Wrong email or password" } });

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect((await call("POST", "/auth/login", { token: null, json: { email: "a@b.dz", password: "x" } })).status).toBe(502);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...ok, user: { ...ok.user, app_metadata: {} } }), { status: 200 }));
    expect((await call("POST", "/auth/login", { token: null, json: { email: "c@d.dz", password: "x" } })).body.user.role).toBe("customer");
    fetchMock.mockRestore();
  });
});
