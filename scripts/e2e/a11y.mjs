/** Basic accessibility check of key storefront pages (alt text, accessible names, labels, one h1 / main, lang, duplicate ids). Run: NODE_PATH=$(npm root -g) node scripts/e2e/a11y.mjs */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000";
const list = await (await fetch(`${API}/catalog/products?locale=ar&limit=1`)).json();
const pages = ["/ar", "/en", `/ar/products/${list[0].slug}`, "/ar/women", "/ar/search?category=tops", "/ar/cart", "/ar/checkout", "/ar/account", "/ar/contact", "/ar/legal/terms", "/ar/sale", "/ar/favorites"];
const b = await chromium.launch();
const p = await (await b.newContext({ ...devices["iPhone 13"] })).newPage();
for (const path of pages) {
  await p.goto(`${WEB}${path}`, { waitUntil: "networkidle" });
  const r = await p.evaluate(() => {
    const out = [];
    const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
    for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) out.push(`img without alt: ${img.src.slice(-40)}`);
    for (const el of document.querySelectorAll("button, a[href]")) if (!name(el) && !el.querySelector("img[alt]:not([alt=''])") && !el.getAttribute("aria-labelledby")) out.push(`${el.tagName.toLowerCase()} without an accessible name: ${el.outerHTML.slice(0, 70)}`);
    for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      const id = el.id; const labelled = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (id && document.querySelector(`label[for="${id}"]`)) || el.closest("label");
      if (!labelled) out.push(`form field without label: ${el.outerHTML.slice(0, 80)}`);
    }
    const h1 = document.querySelectorAll("h1").length; if (h1 !== 1) out.push(`${h1} <h1> elements`);
    if (document.querySelectorAll("main").length !== 1) out.push(`${document.querySelectorAll("main").length} <main> landmarks`);
    if (!document.documentElement.lang) out.push("no lang");
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); const dup = ids.filter((x, i) => ids.indexOf(x) !== i); if (dup.length) out.push(`duplicate ids: ${[...new Set(dup)].slice(0, 3).join(",")}`);
    if (!document.querySelector("meta[name=viewport]")) out.push("no viewport meta");
    return out;
  });
  console.log(path, r.length ? "" : "ok"); for (const x of r) console.log("   -", x);
}
await b.close();
