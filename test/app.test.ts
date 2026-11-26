import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetEnvCache } from "../src/env.js";

beforeEach(() => {
  process.env.WEB_ORIGIN = "https://shop.example";
  process.env.ADMIN_ORIGIN = "https://admin.example";
  resetEnvCache();
});

describe("app", () => {
  it("GET /health returns ok", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("serves the OpenAPI document", async () => {
    const res = await createApp().request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("returns the standard error format for unknown routes", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
  });

  it("allows only configured origins", async () => {
    const app = createApp();
    const ok = await app.request("/health", { headers: { Origin: "https://admin.example" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://admin.example");
    const bad = await app.request("/health", { headers: { Origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("database errors", () => {
  it("maps constraint violations to 4xx without leaking database details", async () => {
    const app = createApp();
    const boom = (code: string) => () => { throw Object.assign(new Error('violates check constraint "secret_name"'), { code }); };
    app.get("/t/check", boom("23514"));
    app.get("/t/unique", boom("23505"));
    app.get("/t/fk", boom("23503"));
    app.get("/t/other", boom("XX000"));
    const body = async (p: string) => { const r = await app.request(p); return { status: r.status, text: await r.text() }; };
    expect(await body("/t/check")).toMatchObject({ status: 422 });
    expect(await body("/t/unique")).toMatchObject({ status: 409 });
    expect(await body("/t/fk")).toMatchObject({ status: 409 });
    const other = await body("/t/other");
    expect(other.status).toBe(500);
    for (const p of ["/t/check", "/t/unique", "/t/fk", "/t/other"]) expect((await body(p)).text).not.toContain("secret_name");
  });
});
