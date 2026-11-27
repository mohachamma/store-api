/**
 * Check of the SEO output (storefront + API running against `npm run dev:local`; the storefront started with
 * NEXT_PUBLIC_SITE_URL=https://www.example-store.dz): titles, descriptions, canonical + hreflang, Open Graph / Twitter,
 * structured data (valid JSON, real price and availability), noindex on private pages, robots.txt and the sitemap
 * (every published product, all three languages). Also: the shop title edited in the dashboard reaches the home page <title>.
 * Run: NODE_PATH=$(npm root -g) node scripts/e2e/seo.mjs
 */
const API = "http://localhost:8787", WEB = "http://localhost:3000";
const SITE = "https://www.example-store.dz";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed++; };
const html = async (path) => (await (await fetch(`${WEB}${path}`)).text()).replace(/hrefLang=/g, "hreflang="); // React writes hrefLang; HTML attributes are case-insensitive
const tag = (h, re) => (re.exec(h) ?? [])[1];
const meta = (h, attr, name) => tag(h, new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)) ?? tag(h, new RegExp(`<meta content="([^"]*)" ${attr}="${name}"`));
const jsonld = (h) => [...h.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].flatMap((m) => JSON.parse(m[1]));
const decode = (s) => s?.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

// --- Home page, all three languages
for (const locale of ["ar", "fr", "en"]) {
  const h = await html(`/${locale}`);
  const title = decode(tag(h, /<title>([^<]*)<\/title>/));
  check(`[${locale}] home has a title and a description`, !!title && (meta(h, "name", "description") ?? "").length > 0, title);
  check(`[${locale}] canonical is absolute and per language`, h.includes(`<link rel="canonical" href="${SITE}/${locale}"`));
  const langs = ["ar", "fr", "en", "x-default"].every((l) => h.includes(`hreflang="${l}" href="${SITE}/${l === "x-default" ? "ar" : l}"`));
  check(`[${locale}] hreflang links to all languages + x-default`, langs);
  check(`[${locale}] Open Graph + Twitter card`, meta(h, "property", "og:title") && meta(h, "property", "og:site_name") && meta(h, "property", "og:locale") && meta(h, "name", "twitter:card"));
  check(`[${locale}] <html> has lang and dir`, new RegExp(`<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"`).test(h));
}
const home = jsonld(await html("/ar"));
check("home structured data: Organization and WebSite with a search action", home.some((d) => d["@type"] === "Organization") && home.some((d) => d["@type"] === "WebSite" && d.potentialAction?.target?.urlTemplate?.includes("search_term_string")));

// --- Product page
const list = await (await fetch(`${API}/catalog/products?locale=ar&limit=100`)).json();
const p = list[0];
const detail = await (await fetch(`${API}/catalog/products/${p.slug}?locale=ar`)).json();
const ph = await html(`/ar/products/${p.slug}`);
check("product page: title and canonical", decode(tag(ph, /<title>([^<]*)<\/title>/))?.includes(detail.name) && ph.includes(`href="${SITE}/ar/products/${p.slug}"`));
const ld = jsonld(ph);
const prod = ld.find((d) => d["@type"] === "Product");
const prices = detail.variants.map((v) => v.price);
check("product structured data: name, DZD price range, availability", prod?.name === detail.name && prod.offers.priceCurrency === "DZD" && prod.offers.lowPrice === Math.min(...prices) && prod.offers.highPrice === Math.max(...prices) && /InStock|OutOfStock/.test(prod.offers.availability), `${prod?.offers?.lowPrice}–${prod?.offers?.highPrice}`);
check("product images are absolute URLs", prod.image.every((u) => u.startsWith("http")));
check("breadcrumb structured data", ld.some((d) => d["@type"] === "BreadcrumbList" && d.itemListElement.length === 2));
check("og:image is set and absolute", /^https?:\/\//.test(meta(ph, "property", "og:image") ?? ""));

// --- Other pages
for (const [path, label] of [["/ar/women", "women"], ["/ar/men", "men"], ["/ar/sale", "sale"], ["/ar/contact", "contact"], ["/ar/legal/privacy", "privacy"], ["/ar/collections/winter", "collection"]]) {
  const h = await html(path);
  check(`${label}: title, canonical and hreflang`, !!tag(h, /<title>([^<]*)<\/title>/) && h.includes(`<link rel="canonical" href="${SITE}${path}"`) && h.includes(`hreflang="en" href="${SITE}${path.replace("/ar", "/en")}"`));
}

// --- Private pages are not indexed
for (const path of ["/ar/cart", "/ar/checkout", "/ar/account", "/ar/favorites", "/ar/search?q=x"]) {
  const h = await html(path);
  check(`noindex on ${path}`, /<meta name="robots" content="noindex/.test(h));
}

// --- robots.txt and sitemap
const robots = await (await fetch(`${WEB}/robots.txt`)).text();
check("robots.txt blocks private pages and points to the sitemap", /Disallow: \/\*\/checkout/.test(robots) && robots.includes(`Sitemap: ${SITE}/sitemap.xml`));
const sm = await (await fetch(`${WEB}/sitemap.xml`)).text();
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check("sitemap lists every published product in all 3 languages", list.every((x) => ["ar", "fr", "en"].every((l) => locs.includes(`${SITE}/${l}/products/${x.slug}`))), `${locs.length} URLs`);
check("sitemap has women, men, sale, collections, legal pages, contact", ["/women", "/men", "/sale", "/collections/winter", "/legal/terms", "/contact"].every((x) => locs.includes(`${SITE}/ar${x}`)));
check("sitemap never lists private pages", !locs.some((l) => /\/(cart|checkout|account|favorites|order|search)/.test(l)));

// --- Editable from the dashboard: the home <title> follows the shop title
const token = (await (await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@store.test", password: "admin1234" }) })).json()).accessToken;
const stamp = Date.now() % 100000;
const info = await (await fetch(`${API}/admin/store-info`, { headers: { authorization: `Bearer ${token}` } })).json();
const save = (body) => fetch(`${API}/admin/store-info`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
await save({ ...info, siteTitle: { ar: `متجر ${stamp}`, fr: "", en: "" }, siteDescription: { ar: `وصف ${stamp}`, fr: "", en: "" } });
console.log("…waiting 65 s for the storefront cache");
await new Promise((r) => setTimeout(r, 65000));
let h2 = "";
for (let i = 0; i < 2; i++) { h2 = await html("/ar"); await new Promise((r) => setTimeout(r, 2500)); }
check("home <title> and description follow what the owner wrote in the dashboard", decode(tag(h2, /<title>([^<]*)<\/title>/)) === `متجر ${stamp}` && decode(meta(h2, "name", "description")) === `وصف ${stamp}`);
await save(info);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
