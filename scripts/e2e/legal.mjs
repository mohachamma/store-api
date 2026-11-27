/**
 * End-to-end check of the information pages (API + dashboard + storefront running against `npm run dev:local`):
 * the draft pages are linked from the footer in the 3 languages; the owner edits a page and the contact details in the
 * dashboard; the storefront shows them (after its 60 s cache) and the draft notice disappears when the page is marked reviewed.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/legal.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const stamp = Date.now() % 100000;

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
for (const p of [shop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) Footer links + draft notice in all three languages
for (const [locale, terms, notice] of [["ar", "الشروط والأحكام", "مسودة"], ["fr", "Conditions générales de vente", "Brouillon"], ["en", "Terms and conditions", "Draft"]]) {
  await shop.goto(`${WEB}/${locale}`, { waitUntil: "networkidle" });
  const link = shop.locator(`footer a:has-text("${terms}")`);
  check(`[${locale}] footer links to the terms page`, (await link.count()) === 1);
  await link.click();
  await shop.waitForURL("**/legal/terms");
  const text = await shop.locator("main").innerText();
  check(`[${locale}] terms page shows headings and the draft notice`, text.includes(notice) && text.length > 800 && (await shop.locator("main h2").count()) >= 8);
}
await shop.goto(`${WEB}/ar/legal/privacy`, { waitUntil: "networkidle" });
check("privacy page is honest about the delivery company and deletion", /شركة التوصيل/.test(await shop.locator("main").innerText()) && /نحذفها/.test(await shop.locator("main").innerText()));
check("unknown page is a 404", (await shop.goto(`${WEB}/ar/legal/nope`)).status() === 404);

// 2) Checkout links to the terms and privacy (needs something in the cart)
const coat = await (await fetch("http://localhost:8787/catalog/products/hooded-deck-coat?locale=ar")).json();
const v = coat.variants.find((x) => x.size === "L");
await shop.goto(`${WEB}/ar`, { waitUntil: "domcontentloaded" });
await shop.evaluate((line) => localStorage.setItem("store.cart.v1", JSON.stringify([line])), { key: `${coat.id}:L`, productId: coat.id, variantId: v.id, slug: coat.slug, name: coat.name, image: coat.image.url, size: "L", price: v.price, qty: 1 });
await shop.goto(`${WEB}/ar/checkout`, { waitUntil: "networkidle" });
check("checkout links to the terms and the privacy policy", (await shop.locator("form a[href$='/legal/terms']").count()) === 1 && (await shop.locator("form a[href$='/legal/privacy']").count()) === 1);

// 3) Dashboard: edit the returns page and the contact details
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/pages`, { waitUntil: "networkidle" });
check("dashboard lists the 5 pages as drafts", (await admin.locator("li:has-text('مسودة')").count()) === 5);
await admin.locator("li:has-text('الإرجاع والتبديل') button").click();
await admin.waitForSelector("[role=dialog]");
await admin.locator("[role=dialog] textarea[name='body.ar']").fill(`## مدة جديدة ${stamp}\nيمكنك الإرجاع خلال 10 أيام.\n\n- القطعة بحالتها الأصلية`);
await admin.locator("[role=dialog] input[name=isDraft]").evaluate((el) => el.click()); // visually hidden switch
await admin.click("[role=dialog] button[type=submit]");
await admin.waitForSelector("[role=dialog]", { state: "detached" });

await admin.fill("#si-phone", "0550 12 34 56"); await admin.fill("#si-wa", "0550123456"); await admin.fill("#si-email", `hello${stamp}@store.dz`);
await admin.fill("input[name='address.ar']", `الجزائر ${stamp}`);
await admin.locator("form:has(#si-phone) button[type=submit]").click();
await admin.waitForSelector("text=تم الحفظ");

// 4) Storefront shows both (its pages are cached for 60 s)
console.log("…waiting 65 s for the storefront cache");
await new Promise((r) => setTimeout(r, 65000));
for (let i = 0; i < 2; i++) { await shop.goto(`${WEB}/ar/legal/returns`, { waitUntil: "networkidle" }); await shop.waitForTimeout(2500); }
const ret = await shop.locator("main").innerText();
check("edited page text is live and the draft notice is gone", ret.includes(`مدة جديدة ${stamp}`) && !ret.includes("مسودة"));
check("bullet list is rendered as a list", (await shop.locator("main li:has-text('بحالتها الأصلية')").count()) === 1);
for (let i = 0; i < 2; i++) { await shop.goto(`${WEB}/ar/contact`, { waitUntil: "networkidle" }); await shop.waitForTimeout(2500); }
const contact = await shop.locator("main").innerText();
check("contact page shows the saved details", contact.includes(`الجزائر ${stamp}`) && contact.includes(`hello${stamp}@store.dz`) && contact.includes("0550 12 34 56"));
check("WhatsApp button links to wa.me", (await shop.locator("a[href='https://wa.me/213550123456']").count()) === 1);
check("phone and email are tappable", (await shop.locator("a[href^='tel:']").count()) === 1 && (await shop.locator("a[href^='mailto:']").count()) === 1);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
