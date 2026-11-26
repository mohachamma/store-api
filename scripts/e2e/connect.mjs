/**
 * End-to-end check that the three apps really work together (no mocks):
 *   store-api  (npm run dev:local)                                    → :8787
 *   store-web  (built with NEXT_PUBLIC_API_URL=http://localhost:8787) → :3000
 *   store-admin(built with NEXT_PUBLIC_API_URL=http://localhost:8787) → :3001
 * Run:  NODE_PATH=$(npm root -g) node scripts/e2e/connect.mjs <big-image.png> [--wait-for-cache]
 * Needs Playwright (global). It changes data through the dashboard UI and checks what the storefront shows.
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
const image = process.argv[2];
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const web = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const p of [web, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) Storefront renders what the API returns
await web.goto(`${WEB}/en`, { waitUntil: "networkidle" });
const home0 = await web.content();
check("storefront shows API content (hero, offer, announcement)", /Winter Collection/.test(home0) && /35% off only this Friday/.test(home0) && /Free delivery/.test(home0));
check("brands strip lists the 8 sample brands", (await web.locator(".marquee-track ul").first().locator("li").count()) >= 8);
await web.goto(`${WEB}/en/sale`, { waitUntil: "networkidle" });
check("sale page lists the 2 discounted products", (await web.locator("main a[href*='/products/']").count()) === 2);
await web.goto(`${WEB}/en/products/nylon-zip-hoodie`, { waitUntil: "networkidle" });
check("product page from the API (sizes XS…XL)", /Nylon Full Zip Hoodie/.test(await web.content()) && (await web.locator("fieldset button").count()) === 5);
await web.goto(`${WEB}/ar/search?q=${encodeURIComponent("جينز")}`, { waitUntil: "networkidle" });
check("Arabic search goes through the API", (await web.locator("main a[href*='/products/']").count()) === 2);

// 2) Dashboard: login against the API, edit content
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "wrong");
await admin.click("button[type=submit]"); await admin.waitForSelector("form [role=alert]");
check("wrong password is refused", true);
await admin.fill("#password", "admin1234"); await admin.click("button[type=submit]");
await admin.waitForURL(`${ADMIN}/`);
check("overview explains that statistics are not built yet", /المرحلة 5/.test(await admin.content()));

await admin.goto(`${ADMIN}/brands`, { waitUntil: "networkidle" });
check("dashboard lists the API's brands", (await admin.locator("ul.divide-y > li").count()) === 8);
await admin.click("text=إضافة علامة");
await admin.fill("#brand-name", "DUNES");
await admin.setInputFiles("[role=dialog] input[type=file]", image);
await admin.waitForSelector("text=تم تصغير الصورة");
await admin.click("[role=dialog] button[type=submit]");
await admin.waitForSelector("li:has-text('DUNES')");
const brands = await (await fetch(`${API}/catalog/brands`)).json();
const dunes = brands.find((b) => b.name === "DUNES");
check("new brand is public through the API", !!dunes && brands.at(-1).name === "DUNES");
const img = dunes && (await fetch(dunes.logo.url));
check("uploaded logo is a small WebP served from the image bucket", !!img && img.headers.get("content-type") === "image/webp" && (await img.arrayBuffer()).byteLength < 300_000, dunes?.logo.url);

await admin.locator("li:has-text('DUNES') button[aria-label='تقديم']").click();
await admin.waitForTimeout(700);
await admin.locator("label:has-text('حركة تلقائية')").click();
await admin.click("form:has(#speed) button[type=submit]"); await admin.waitForSelector("text=تم الحفظ");
check("animation switch saved (strip not animated)", (await (await fetch(`${API}/catalog/home`)).json()).brandsStrip.animated === false);

await admin.goto(`${ADMIN}/content`, { waitUntil: "networkidle" });
await admin.fill("input[name='announcement.ar']", "تخفيض 20% على كل شيء");
await admin.fill("input[name='announcement.en']", "20% off everything");
await admin.click("main form button[type=submit]"); await admin.waitForSelector("text=تم الحفظ");
check("announcement saved", (await (await fetch(`${API}/catalog/site?locale=en`)).json()).announcement === "20% off everything");

await admin.goto(`${ADMIN}/offers`, { waitUntil: "networkidle" });
await admin.click("text=إضافة عرض");
await admin.fill("[role=dialog] input[name='title.ar']", "عرض نهاية الأسبوع"); await admin.fill("[role=dialog] input[name='title.en']", "Weekend deal");
await admin.fill("[role=dialog] input[name='ctaLabel.ar']", "تسوّق الآن"); await admin.fill("[role=dialog] input[name='ctaLabel.en']", "Shop now");
await admin.click("[role=dialog] button[type=submit]");
await admin.waitForSelector("text=عرض نهاية الأسبوع");
check("new offer is public through the API", (await (await fetch(`${API}/catalog/home?locale=en`)).json()).offers.some((o) => o.title === "Weekend deal"));
await admin.fill("main form:has(input[name='enabled']) input[name='title.en']", "Mega Sale");
await admin.click("main form:has(input[name='enabled']) button[type=submit]"); await admin.waitForSelector("main form:has(input[name='enabled']) >> text=تم الحفظ");
check("sale page title saved", (await (await fetch(`${API}/catalog/sale?locale=en`)).json()).title === "Mega Sale");

// 3) The storefront picks the changes up (its data cache lasts 60 s)
if (process.argv.includes("--wait-for-cache")) {
  console.log("…waiting 65 s for the storefront cache");
  await new Promise((r) => setTimeout(r, 65_000));
  // After the cache expires the first visit is served the old page while Next refreshes it in the background.
  await web.goto(`${WEB}/en`, { waitUntil: "networkidle" });
  await web.goto(`${WEB}/en/sale`, { waitUntil: "networkidle" });
  await new Promise((r) => setTimeout(r, 4000));
  await web.goto(`${WEB}/en`, { waitUntil: "networkidle" });
  const html = await web.content();
  check("storefront now shows the new announcement", /20% off everything/.test(html));
  check("storefront now shows the new offer", /Weekend deal/.test(html));
  check("storefront brands strip is static and has the new brand", (await web.locator("ul:has(img[alt='DUNES'])").count()) >= 1 && (await web.locator(".marquee-track").count()) === 0);
  await web.screenshot({ path: process.env.SHOT ?? "/tmp/connect-home.png", fullPage: false });
  await web.goto(`${WEB}/en/sale`, { waitUntil: "networkidle" });
  check("storefront sale page has the new title", /Mega Sale/.test(await web.content()));
}

await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
