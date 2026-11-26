/**
 * End-to-end check of the editable home sections (API + dashboard + storefront running against `npm run dev:local`):
 * edit "why us", add a category card, change the newsletter block in the dashboard → the storefront shows them
 * (after its 60 s page cache) → a visitor subscribes → the email shows up in the dashboard.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/home.mjs <image.png>
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
const image = process.argv[2];
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const stamp = Date.now() % 100000;

const browser = await chromium.launch();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
for (const p of [admin, shop]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
await admin.goto(`${ADMIN}/content`, { waitUntil: "networkidle" });

// 1) Category card
await admin.click("text=إضافة بطاقة");
await admin.setInputFiles("[role=dialog] input[type=file]", image);
await admin.fill("[role=dialog] input[name='title.ar']", `أحذية ${stamp}`);
await admin.fill("[role=dialog] input[name='title.fr']", `Chaussures ${stamp}`);
await admin.fill("[role=dialog] input[name=href]", "/sale");
await admin.waitForTimeout(1500);
await admin.click("[role=dialog] button[type=submit]");
await admin.waitForSelector(`li:has-text('أحذية ${stamp}')`);
let home = await (await fetch(`${API}/catalog/home?locale=fr`)).json();
check("new category card is public with its link", home.categoryCards.some((c) => c.title === `Chaussures ${stamp}` && c.href === "/sale"));

// 2) Why us: rename the title and first feature
const whyForm = admin.locator("form:has(input[name='item0title.ar'])");
await whyForm.locator("input[name='title.ar']").fill(`مزايانا ${stamp}`);
await whyForm.locator("input[name='item0title.ar']").fill(`ميزة ${stamp}`);
await whyForm.locator("button[type=submit]").click();
await admin.waitForSelector("text=تم الحفظ");
home = await (await fetch(`${API}/catalog/home?locale=ar`)).json();
check("why-us edits are public", home.whyUs.title === `مزايانا ${stamp}` && home.whyUs.items[0].title === `ميزة ${stamp}`);

// 3) Newsletter block texts
const nl = admin.locator("form:has(input[name='button.ar'])");
await nl.locator("input[name='title.ar']").fill(`انضم ${stamp}`);
await nl.locator("button[type=submit]").click();
await admin.waitForSelector("text=تم الحفظ >> nth=1");
home = await (await fetch(`${API}/catalog/home?locale=ar`)).json();
check("newsletter title is public", home.newsletter.title === `انضم ${stamp}`);

// 4) Storefront shows everything (its pages are cached for 60 s)
console.log("…waiting 65 s for the storefront cache");
await new Promise((r) => setTimeout(r, 65000));
// Next serves the stale page once and rebuilds it in the background: load twice.
await shop.goto(`${WEB}/ar`, { waitUntil: "networkidle" });
await shop.waitForTimeout(3000);
await shop.goto(`${WEB}/ar`, { waitUntil: "networkidle" });
const text = await shop.locator("main").innerText();
check("storefront shows the new card, why-us texts and newsletter title", text.includes(`أحذية ${stamp}`) && text.includes(`مزايانا ${stamp}`) && text.includes(`ميزة ${stamp}`) && text.includes(`انضم ${stamp}`));
check("category card links to the chosen page", (await shop.locator(`a:has-text('أحذية ${stamp}')`).getAttribute("href")).endsWith("/sale"));

// 5) A visitor subscribes → the dashboard lists the email
const email = `visitor${stamp}@example.com`;
await shop.fill("#nl-email", email);
await shop.click("section button:has-text('اشترك')");
await shop.waitForSelector("text=تم تسجيل بريدك");
await admin.goto(`${ADMIN}/content`, { waitUntil: "networkidle" });
check("the dashboard lists the new subscriber", await admin.locator(`li:has-text('${email}')`).count() === 1);
await admin.locator(`li:has-text('${email}') button`).click().catch(() => {});
admin.once("dialog", (d) => d.accept());
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
