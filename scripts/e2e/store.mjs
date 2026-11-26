/**
 * End-to-end check of phase 5b through the dashboard (API + dashboard running):
 * shipping fees, free-delivery threshold, discount codes, hero slides.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/store.mjs <image.png>
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", ADMIN = "http://localhost:3001";
const image = process.argv[2];
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const get = async (path) => (await fetch(`${API}${path}`)).json();

const browser = await chromium.launch();
const p = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
p.on("pageerror", (e) => console.log("PAGEERR", e.message));
await p.goto(`${ADMIN}/login`);
await p.fill("#email", "admin@store.test"); await p.fill("#password", "admin1234");
await p.click("button[type=submit]"); await p.waitForURL(`${ADMIN}/`);

// 1) Shipping: bulk fee for filtered wilaya + threshold
await p.goto(`${ADMIN}/shipping`, { waitUntil: "networkidle" });
check("58 wilayas listed", (await p.locator("ul > li").count()) === 58, String(await p.locator("ul > li").count()));
await p.fill("input[type=text][dir=auto], input[placeholder]:not([inputmode])", "16");
const rows = await p.locator("ul > li").count();
check("search narrows the list", rows >= 1 && rows < 10, String(rows));
const row = p.locator("ul > li").first();
const inputs = row.locator("input[inputmode=numeric]");
const fee = String(500 + Math.floor(Math.random() * 400));
await inputs.nth(0).fill(fee);
await p.click("text=حفظ الأسعار");
await p.waitForSelector("text=تم حفظ");
const wil = await get("/shipping/wilayas");
check("fee change is public", wil.some((w) => w.homeFee === Number(fee)), JSON.stringify(wil.find((w) => w.homeFee === Number(fee))?.code));
const free = String(10000 + Math.floor(Math.random() * 5000));
await p.fill("#free", free);
await p.click("button:has-text('حفظ'):not(:has-text('الأسعار'))");
await p.waitForSelector("text=تم الحفظ");
const rules = await get("/shipping/rules");
check("free-delivery threshold saved", JSON.stringify(rules).includes(free), JSON.stringify(rules));

// 2) Discount code
await p.goto(`${ADMIN}/discounts`, { waitUntil: "networkidle" });
const code = "E2E" + Math.floor(Math.random() * 90000 + 10000);
await p.click("text=إضافة كود");
await p.fill("[role=dialog] input[name=code]", code.toLowerCase());
await p.fill("[role=dialog] input[name=value]", "20");
await p.click("[role=dialog] button[type=submit]");
await p.waitForSelector(`li:has-text('${code}')`);
check("code listed in uppercase", true);
await p.click("text=إضافة كود");
await p.fill("[role=dialog] input[name=code]", code);
await p.fill("[role=dialog] input[name=value]", "5");
await p.click("[role=dialog] button[type=submit]");
await p.waitForSelector("[role=dialog] [role=alert]");
check("duplicate code shows a clear error", (await p.textContent("[role=dialog] [role=alert]")).includes("موجود"));
await p.keyboard.press("Escape");

// 3) Hero slide
await p.goto(`${ADMIN}/content`, { waitUntil: "networkidle" });
await p.click("text=إضافة شريحة");
await p.setInputFiles("[role=dialog] input[type=file]", image);
await p.fill("[role=dialog] input[name='title.ar']", "شتاء جديد");
await p.fill("[role=dialog] input[name='title.fr']", "Nouvel hiver");
await p.waitForTimeout(1500);
await p.click("[role=dialog] button[type=submit]");
await p.waitForSelector("li:has-text('شتاء جديد')");
for (let i = 0; i < 6; i++) {
  const up = p.locator("li:has-text('شتاء جديد')").last().locator("button[aria-label='↑']");
  if (await up.isDisabled()) break;
  await up.click(); await p.waitForTimeout(700);
}
const home = await get("/catalog/home?locale=ar");
check("slide is the hero of the home page", home.hero?.title === "شتاء جديد", JSON.stringify(home.hero?.title));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
