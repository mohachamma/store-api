import { createHmac } from "node:crypto";
import { getEnv } from "../env.js";

/**
 * One-way keyed fingerprints (HMAC-SHA256) of a phone number and of an IP address.
 * The same input always gives the same fingerprint, so we can tell that two orders came from the same person,
 * but nobody can recover the number or the address from it (a plain hash could be reversed by trying every phone number; the secret key prevents that).
 * Null when FINGERPRINT_SECRET is not set: nothing is stored then.
 */
function hmac(kind: "phone" | "ip", value: string): string | null {
  const secret = getEnv().FINGERPRINT_SECRET;
  return secret ? createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex") : null;
}

/** `phone` must already be normalized (0550123456), so "+213 550 12 34 56" and "0550123456" match. */
export const phoneKey = (phone: string) => hmac("phone", phone);
export const ipKey = (ip: string | null | undefined) => (ip ? hmac("ip", ip.trim().toLowerCase()) : null);

/** Short, harmless label for a fingerprint, to tell buyers apart on screen ("A3F9-12BC"). */
export const buyerCode = (key: string) => `${key.slice(0, 4)}-${key.slice(4, 8)}`.toUpperCase();

/**
 * The visitor's IP, as forwarded by the storefront. Only believed when the storefront proves who it is (shared secret);
 * otherwise we would only see the storefront's own server (or an address anyone could invent).
 */
export function trustedClientIp(headers: { get(name: string): string | undefined | null }): string | null {
  const secret = getEnv().STOREFRONT_SECRET;
  if (!secret || headers.get("x-storefront-secret") !== secret) return null;
  const ip = (headers.get("x-client-ip") ?? "").trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
}
