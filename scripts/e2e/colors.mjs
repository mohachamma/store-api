/* global getComputedStyle */
/**
 * End-to-end check of color swatches (API + dashboard + storefront against `npm run dev:local`):
 * round color dots on product cards, swatches on the product page, tapping a color swaps the photos and the sizes without
 * any recoloring, two colors of the same size are two cart lines, and the dashboard's color picker saves the owner's exact color.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/colors.mjs
 */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000", ADMIN = "http://localhost:3001";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };

const browser = await chromium.launch();
const shop = await (await browser.newContext({ ...devices["iPhone 13"] })).newPage();
const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
for (const p of [shop, admin]) p.on("pageerror", (e) => console.log("PAGEERR", e.message));

// 1) Dots on cards
await shop.goto(`${WEB}/ar/search?q=Heavy`, { waitUntil: "networkidle" });
const card = shop.locator("main a[href$='/products/heavy-tee-cream']");
const dots = await card.locator("ul li[title]").evaluateAll((els) => els.map((e) => ({ title: e.getAttribute("title"), bg: getComputedStyle(e).backgroundColor, round: getComputedStyle(e).borderRadius })));
check("the card shows one round dot per color (black + cream)", dots.length === 2 && dots.every((d) => d.bg && parseFloat(d.round) > 0), JSON.stringify(dots.map((d) => `${d.title}:${d.bg}`)));
check("the dots use the colors chosen in the dashboard data", dots.some((d) => d.bg === "rgb(17, 17, 17)") && dots.some((d) => d.bg === "rgb(241, 233, 216)"));

// 2) Product page: swatches, photos and sizes follow the color
await shop.goto(`${WEB}/ar/products/heavy-tee-cream`, { waitUntil: "networkidle" });
const sw = shop.locator("fieldset button[aria-pressed][aria-label]:has(span[style*='background'])");
check("the product page has a round swatch per color", (await sw.count()) === 2);
const srcs = async () => shop.locator("[aria-roledescription=carousel] img").evaluateAll((els) => els.map((e) => decodeURIComponent(e.getAttribute("src") ?? "")));
const sizes = async () => (await shop.locator("fieldset:has(legend:has-text('المقاس')) button").allInnerTexts()).map((s) => s.trim());
const creamSrc = await srcs();
check("cream selected: cream photos only", creamSrc.length >= 3 && creamSrc.every((s) => s.includes("tee-cream")), creamSrc.join(","));
check("cream has its own sizes XS–XL", (await sizes()).join(",") === "XS,S,M,L,XL", (await sizes()).join(","));
await shop.click("button[aria-label='أسود']");
await shop.waitForTimeout(500);
const blackSrc = await srcs();
check("black selected: the gallery shows black photos (no recolor, real photos)", blackSrc.length === 2 && blackSrc.every((s) => s.includes("tee-black")), blackSrc.join(","));
check("black has only the sizes that exist in black (M, L)", (await sizes()).join(",") === "M,L", (await sizes()).join(","));

// 3) Cart: same size in two colors = two lines
await shop.click("button:has-text('أضف إلى السلة')");
await shop.waitForTimeout(2300);
await shop.click("button[aria-label='كريمي']");
await shop.waitForTimeout(300);
await shop.locator("fieldset:has(legend:has-text('المقاس')) button", { hasText: /^M$/ }).click();
await shop.click("button:has-text('أضف إلى السلة')");
await shop.waitForTimeout(2300);
const lines = await shop.evaluate(() => JSON.parse(localStorage.getItem("store.cart.v1") || "[]").map((l) => `${l.color}/${l.size}/${l.qty}`));
check("black M and cream M are two separate cart lines with their colors", lines.length === 2 && lines.some((l) => l.startsWith("black/M")) && lines.some((l) => l.startsWith("cream/M")), lines.join(" | "));
await shop.goto(`${WEB}/ar/cart`, { waitUntil: "networkidle" });
const cartText = await shop.locator("main").innerText();
check("the cart shows the color names (translated)", /أسود/.test(cartText) && /كريمي/.test(cartText));

// 4) Shop filter panel: colors as dots
await shop.goto(`${WEB}/ar/search`, { waitUntil: "networkidle" });
await shop.click("button:has-text('تصفية')");
await shop.waitForSelector("dialog[open]");
check("filter panel lists colors with round dots", (await shop.locator("dialog[open] label:has(input[name=color]) span[style*='background']").count()) >= 5);

// 5) Dashboard: pick the color with the picker, save, and see it on the storefront data
await admin.goto(`${ADMIN}/login`);
await admin.fill("#email", "admin@store.test"); await admin.fill("#password", "admin1234");
await admin.click("button[type=submit]"); await admin.waitForURL(`${ADMIN}/`);
const prod = await (await fetch(`${API}/catalog/products/denim-track-jacket?locale=ar`)).json();
const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@store.test", password: "admin1234" }) })).json()).accessToken;
const ap = await (await fetch(`${API}/admin/products?q=denim-track&limit=5`, { headers: { authorization: `Bearer ${token}` } })).json();
await admin.goto(`${ADMIN}/products/${ap.items[0].id}`, { waitUntil: "networkidle" });
check("the variants table has a round color picker per row", (await admin.locator("button[aria-label='اختر اللون']").count()) >= 1);
await admin.locator("button[aria-label='اختر اللون']").first().click();
await admin.click("button[aria-label='أحمر']");
await admin.locator("form button[type=submit]").last().click();
await admin.waitForURL(`${ADMIN}/products`, { timeout: 15000 });
const after = await (await fetch(`${API}/catalog/products/denim-track-jacket?locale=ar`)).json();
check("the chosen red is saved and public", after.variants.every((v) => v.colorHex === "#c0392b"), after.variants.map((v) => v.colorHex).join(","));
// restore
const orig = prod.variants[0].colorHex;
await admin.goto(`${ADMIN}/products/${ap.items[0].id}`, { waitUntil: "networkidle" });
await admin.locator("button[aria-label='اختر اللون']").first().click();
const preset = { "#4a6fa5": "جينز" }[orig];
if (preset) await admin.click(`button[aria-label='${preset}']`);
await admin.locator("form button[type=submit]").last().click();
await admin.waitForURL(`${ADMIN}/products`, { timeout: 15000 });

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
