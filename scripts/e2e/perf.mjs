/* global window */
/** Speed check on emulated slow 4G + 4x slower CPU: LCP, layout shift, JS size. Run: NODE_PATH=$(npm root -g) node scripts/e2e/perf.mjs */
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const API = "http://localhost:8787", WEB = "http://localhost:3000";
const list = await (await fetch(`${API}/catalog/products?locale=ar&limit=1`)).json();
const b = await chromium.launch();
for (const path of ["/ar", `/ar/products/${list[0].slug}`, "/ar/women", "/ar/search?category=tops"]) {
  const ctx = await b.newContext({ ...devices["Pixel 5"] });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }); // "Slow 4G"
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await p.addInitScript(() => { window.__m = { lcp: 0, cls: 0 }; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: "layout-shift", buffered: true }); });
  await p.goto(`${WEB}${path}`, { waitUntil: "load" }); await p.waitForTimeout(2500);
  const m = await p.evaluate(() => window.__m);
  const js = await p.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js")).reduce((n, r) => n + r.transferSize, 0));
  console.log(path.padEnd(34), `LCP ${Math.round(m.lcp)} ms (slow 4G, 4x CPU)  CLS ${m.cls.toFixed(3)}  JS ${(js / 1024).toFixed(0)} KB`);
  await ctx.close();
}
await b.close();
