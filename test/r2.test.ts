import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../src/env.js";
import { imageUrl, toStoredPath } from "../src/lib/media.js";
import { createR2Storage } from "../src/lib/storage.js";

beforeEach(() => {
  Object.assign(process.env, {
    R2_ACCOUNT_ID: "acc123",
    R2_ACCESS_KEY_ID: "AKIATEST",
    R2_SECRET_ACCESS_KEY: "secret-secret-secret",
    R2_BUCKET: "store-images",
    R2_PUBLIC_URL: "https://img.example.com/",
  });
  resetEnvCache();
});

describe("R2 storage", () => {
  it("sends a signed PUT to the bucket with the right headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    await createR2Storage(fetchMock as unknown as typeof fetch).upload("uploads/2026/11/a b.png", new Uint8Array([1, 2, 3]), "image/png");
    const [req] = fetchMock.mock.calls[0] as unknown as [Request];
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("https://acc123.r2.cloudflarestorage.com/store-images/uploads/2026/11/a%20b.png");
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/auto\/s3\/aws4_request/);
    expect(req.headers.get("content-type")).toBe("image/png");
    expect(req.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("turns a storage failure into a clean 502 without leaking details", async () => {
    const fetchMock = vi.fn(async () => new Response("<Error>SignatureDoesNotMatch</Error>", { status: 403 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createR2Storage(fetchMock as unknown as typeof fetch).upload("k.png", new Uint8Array([1]), "image/png")).rejects.toMatchObject({ status: 502, code: "storage_error", message: "Could not store the image" });
  });

  it("refuses to run when R2 is not configured", async () => {
    delete process.env.R2_SECRET_ACCESS_KEY;
    resetEnvCache();
    await expect(createR2Storage(vi.fn() as unknown as typeof fetch).upload("k.png", new Uint8Array([1]), "image/png")).rejects.toMatchObject({ status: 503 });
  });
});

describe("image URLs", () => {
  it("builds public URLs from keys and keeps placeholders and absolute URLs", () => {
    expect(imageUrl("uploads/2026/11/a.png")).toBe("https://img.example.com/uploads/2026/11/a.png");
    expect(imageUrl("/placeholders/x.svg")).toBe("/placeholders/x.svg");
    expect(imageUrl("https://cdn.other.com/a.png")).toBe("https://cdn.other.com/a.png");
    expect(imageUrl(null)).toBeNull();
  });
  it("stores only the key when the URL points at our bucket", () => {
    expect(toStoredPath("https://img.example.com/uploads/2026/11/a.png")).toBe("uploads/2026/11/a.png");
    expect(toStoredPath("/placeholders/x.svg")).toBe("/placeholders/x.svg");
    expect(toStoredPath("https://cdn.other.com/a.png")).toBe("https://cdn.other.com/a.png");
  });
});
