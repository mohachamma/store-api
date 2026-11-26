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
const home = async (locale = "ar") => (await api("GET", `/catalog/home?locale=${locale}`)).body;

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

describe("home sections ship with editable defaults", () => {
  it("the home page returns why-us, category cards and the newsletter block, translated", async () => {
    const h = await home("fr");
    expect(h.whyUs.title).toBe("Pourquoi nous");
    expect(h.whyUs.items).toHaveLength(4);
    expect(h.whyUs.items[0]).toMatchObject({ icon: "truck", title: "Livraison dans 58 wilayas" });
    expect(h.categoryCards.map((c: { title: string }) => c.title)).toEqual(["Homme", "Femme", "Casual", "Meilleures ventes"]);
    expect(h.newsletter).toMatchObject({ title: "Soyez les premiers informés", button: "S'abonner" });
  });
});

describe("why us (dashboard)", () => {
  it("is edited from the dashboard and switched off with one flag", async () => {
    const cur = (await admin("GET", "/admin/why-us")).body;
    expect(cur.items).toHaveLength(4);
    const items = [{ icon: "gift", title: { ar: "هدية مع كل طلب", fr: "", en: "" }, text: { ar: "", fr: "", en: "" } }];
    expect((await admin("PUT", "/admin/why-us", { enabled: true, title: { ar: "مزايانا", fr: "", en: "" }, items })).status).toBe(200);
    const h = await home();
    expect(h.whyUs).toEqual({ title: "مزايانا", items: [{ icon: "gift", title: "هدية مع كل طلب", text: null }] });
    await admin("PUT", "/admin/why-us", { enabled: false, title: { ar: "مزايانا", fr: "", en: "" }, items });
    expect((await home()).whyUs).toBeNull();
  });
  it("refuses unknown icons, more than 8 items, and French text without Arabic", async () => {
    const t = { ar: "x", fr: "", en: "" };
    expect((await admin("PUT", "/admin/why-us", { enabled: true, title: t, items: [{ icon: "rocket", title: t }] })).status).toBe(422);
    expect((await admin("PUT", "/admin/why-us", { enabled: true, title: t, items: Array.from({ length: 9 }, () => ({ icon: "star", title: t })) })).status).toBe(422);
    expect((await admin("PUT", "/admin/why-us", { enabled: true, title: t, items: [{ icon: "star", title: t, text: { ar: "", fr: "texte", en: "" } }] })).status).toBe(422);
  });
});

describe("category cards (dashboard)", () => {
  it("add, order, hide, edit and delete", async () => {
    const before = (await admin("GET", "/admin/home-cards")).body.length;
    const add = await admin("POST", "/admin/home-cards", { title: { ar: "أحذية", fr: "Chaussures", en: "" }, imageUrl: "https://img.example.com/uploads/shoes.webp", href: "/search?category=shoes" });
    expect(add.status).toBe(200);
    const id = add.body.id;
    let h = await home();
    expect(h.categoryCards).toHaveLength(before + 1);
    expect(h.categoryCards.at(-1)).toMatchObject({ title: "أحذية", href: "/search?category=shoes", image: { url: "https://img.example.com/uploads/shoes.webp" } });
    await admin("POST", `/admin/home-cards/${id}/move`, { direction: -1 });
    h = await home();
    expect(h.categoryCards.at(-2).id).toBe(id);
    await admin("PUT", `/admin/home-cards/${id}`, { title: { ar: "أحذية", fr: "Chaussures", en: "" }, imageUrl: "https://img.example.com/uploads/shoes.webp", href: null, isActive: false });
    expect((await home()).categoryCards).toHaveLength(before);
    expect((await admin("DELETE", `/admin/home-cards/${id}`)).status).toBe(200);
    expect((await admin("DELETE", `/admin/home-cards/${id}`)).status).toBe(404);
  });
  it("refuses unsafe links, inline images and a French-only subtitle", async () => {
    const base = { title: { ar: "x", fr: "", en: "" }, imageUrl: "https://img.example.com/a.webp" };
    expect((await admin("POST", "/admin/home-cards", { ...base, href: "javascript:alert(1)" })).status).toBe(422);
    expect((await admin("POST", "/admin/home-cards", { ...base, imageUrl: "data:image/png;base64,AAAA" })).status).toBe(422);
    expect((await admin("POST", "/admin/home-cards", { ...base, subtitle: { ar: "", fr: "sous-titre", en: "" } })).status).toBe(422);
  });
});

describe("newsletter", () => {
  it("collects emails once each, normalised, and the dashboard lists and removes them", async () => {
    expect((await api("POST", "/newsletter", { email: " Sara@Example.COM " })).status).toBe(200);
    expect((await api("POST", "/newsletter", { email: "sara@example.com" })).status).toBe(200); // same answer for a repeat
    expect((await api("POST", "/newsletter", { email: "not-an-email" })).status).toBe(422);
    const list = await admin("GET", "/admin/newsletter/subscribers");
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ email: "sara@example.com" });
    expect((await admin("DELETE", `/admin/newsletter/subscribers/${list.body.items[0].id}`)).status).toBe(200);
    expect((await admin("GET", "/admin/newsletter/subscribers")).body.total).toBe(0);
  });
  it("subscribers need an admin token", async () => {
    expect((await api("GET", "/admin/newsletter/subscribers")).status).toBe(401);
  });
  it("the block texts are edited from the dashboard and can be hidden", async () => {
    expect((await admin("PUT", "/admin/newsletter", { enabled: true, title: { ar: "انضم إلينا", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, button: { ar: "سجّلني", fr: "", en: "" } })).status).toBe(200);
    expect((await home()).newsletter).toEqual({ title: "انضم إلينا", subtitle: null, button: "سجّلني" });
    await admin("PUT", "/admin/newsletter", { enabled: false, title: { ar: "انضم إلينا", fr: "", en: "" }, subtitle: { ar: "", fr: "", en: "" }, button: { ar: "سجّلني", fr: "", en: "" } });
    expect((await home()).newsletter).toBeNull();
  });
});
