import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret-test-secret-test-secret-123";
let app: ReturnType<typeof createApp>;
let pg: Awaited<ReturnType<typeof createTestDb>>["pg"];
let adminToken: string;

async function api(method: string, path: string, json?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const admin = (m: string, p: string, j?: unknown) => api(m, p, j, adminToken);

beforeAll(async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.R2_PUBLIC_URL = "https://img.example.com";
  resetEnvCache();
  const t = await createTestDb();
  pg = t.pg;
  app = createApp({ db: t.db, storage: { upload: async () => {} } });
  adminToken = await new SignJWT({ app_metadata: { role: "admin" } }).setProtectedHeader({ alg: "HS256" }).setSubject("00000000-0000-0000-0000-0000000000aa").setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}, 60_000);
afterAll(() => pg.close());

describe("information pages", () => {
  it("ship with draft texts in three languages", async () => {
    const list = (await api("GET", "/catalog/pages?locale=fr")).body;
    expect(list.map((p: { slug: string }) => p.slug)).toEqual(["terms", "privacy", "returns", "shipping", "cod"]);
    expect(list[0].title).toBe("Conditions générales de vente");
    for (const locale of ["ar", "fr", "en"]) {
      for (const p of list) {
        const page = (await api("GET", `/catalog/pages/${p.slug}?locale=${locale}`)).body;
        expect(page.body.length, `${p.slug}/${locale}`).toBeGreaterThan(400);
        expect(page.isDraft).toBe(true);
        expect(page.draftNotice).toMatch(locale === "ar" ? /مسودة/ : locale === "fr" ? /Brouillon/ : /Draft/);
      }
    }
  });

  it("the privacy page tells the truth about the delivery company and deletion", async () => {
    const en = (await api("GET", "/catalog/pages/privacy?locale=en")).body.body as string;
    expect(en).toMatch(/delivery company/i);
    expect(en).toMatch(/delete them permanently/i);
    expect(en).toMatch(/18-07/);
  });

  it("unknown or unpublished pages are 404", async () => {
    expect((await api("GET", "/catalog/pages/nope")).status).toBe(404);
    const t = (await admin("GET", "/admin/pages")).body.find((p: { slug: string }) => p.slug === "cod");
    await admin("PUT", "/admin/pages/cod", { title: t.title, body: t.body, isPublished: false, isDraft: true });
    expect((await api("GET", "/catalog/pages/cod")).status).toBe(404);
    expect((await api("GET", "/catalog/pages")).body.map((p: { slug: string }) => p.slug)).not.toContain("cod");
    await admin("PUT", "/admin/pages/cod", { title: t.title, body: t.body, isPublished: true, isDraft: true });
  });
});

describe("pages are edited from the dashboard", () => {
  it("saves the text and removes the draft notice once the lawyer has reviewed it", async () => {
    const put = await admin("PUT", "/admin/pages/returns", { title: { ar: "الإرجاع", fr: "Retours", en: "Returns" }, body: { ar: "## نص جديد\nمدة 10 أيام.", fr: "", en: "" }, isPublished: true, isDraft: false });
    expect(put.status).toBe(200);
    const page = (await api("GET", "/catalog/pages/returns?locale=ar")).body;
    expect(page).toMatchObject({ title: "الإرجاع", body: "## نص جديد\nمدة 10 أيام.", isDraft: false, draftNotice: null });
    // another language falls back to Arabic when its translation is empty
    expect((await api("GET", "/catalog/pages/returns?locale=en")).body.title).toBe("Returns");
    expect((await api("GET", "/catalog/pages/returns?locale=fr")).body.body).toBe("## نص جديد\nمدة 10 أيام.");
  });
  it("refuses an empty Arabic text, an unknown page, and visitors", async () => {
    const ok = { title: { ar: "x", fr: "", en: "" }, isPublished: true, isDraft: true };
    expect((await admin("PUT", "/admin/pages/terms", { ...ok, body: { ar: "", fr: "texte", en: "" } })).status).toBe(422);
    expect((await admin("PUT", "/admin/pages/other", { ...ok, body: { ar: "x", fr: "", en: "" } })).status).toBe(404);
    expect((await api("PUT", "/admin/pages/terms", { ...ok, body: { ar: "x", fr: "", en: "" } })).status).toBe(401);
  });
});

describe("contact details", () => {
  it("are empty at first, then show what the owner saves (with a WhatsApp link)", async () => {
    expect((await api("GET", "/catalog/store-info")).body).toEqual({ phone: null, email: null, address: null, hours: null, whatsappUrl: null, siteTitle: null, siteDescription: null });
    const save = await admin("PUT", "/admin/store-info", { phone: "0550 12 34 56", whatsapp: "0550123456", email: "hello@store.dz", address: { ar: "الجزائر العاصمة", fr: "Alger", en: "" }, hours: { ar: "كل يوم 9–18", fr: "", en: "" }, siteTitle: { ar: "متجر الجزائر", fr: "Store Alger", en: "" } });
    expect(save.status).toBe(200);
    expect((await api("GET", "/catalog/store-info?locale=fr")).body).toEqual({ phone: "0550 12 34 56", email: "hello@store.dz", address: "Alger", hours: "كل يوم 9–18", whatsappUrl: "https://wa.me/213550123456", siteTitle: "Store Alger", siteDescription: null });
  });
  it("refuses a bad WhatsApp number, a bad email, and French without Arabic", async () => {
    const base = { phone: "", whatsapp: "", email: "", address: { ar: "", fr: "", en: "" }, hours: { ar: "", fr: "", en: "" } };
    expect((await admin("PUT", "/admin/store-info", { ...base, whatsapp: "12" })).status).toBe(422);
    expect((await admin("PUT", "/admin/store-info", { ...base, email: "not-an-email" })).status).toBe(422);
    expect((await admin("PUT", "/admin/store-info", { ...base, address: { ar: "", fr: "Alger", en: "" } })).status).toBe(422);
  });
});

describe("collections for menus", () => {
  it("lists published collections in order, translated, and hides unpublished ones", async () => {
    const list = (await api("GET", "/catalog/collections?locale=fr")).body as { slug: string; title: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => c.slug && c.title)).toBe(true);
    await pg.query(`update collections set is_published = false where slug = $1`, [list[0]!.slug]);
    const after = (await api("GET", "/catalog/collections")).body as { slug: string }[];
    expect(after.map((c) => c.slug)).not.toContain(list[0]!.slug);
    await pg.query(`update collections set is_published = true where slug = $1`, [list[0]!.slug]);
  });
});
