import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { MiddlewareHandler } from "hono";
import { getEnv } from "../env.js";
import type { Query } from "./db.js";
import { ApiError } from "./errors.js";

export interface AdminClaims extends JWTPayload {
  app_metadata?: { role?: string };
  email?: string;
  user_metadata?: { full_name?: string };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Verifies a Supabase access token (HS256 secret, or the project's JWKS) and returns its claims. */
export async function verifyToken(token: string): Promise<AdminClaims> {
  const env = getEnv();
  try {
    if (env.SUPABASE_JWT_SECRET) {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET), { algorithms: ["HS256"] });
      return payload as AdminClaims;
    }
    if (!env.SUPABASE_URL) throw new ApiError(503, "service_unavailable", "Authentication is not configured");
    jwks ??= createRemoteJWKSet(new URL(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks);
    return payload as AdminClaims;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(401, "unauthorized", "Invalid or expired token");
  }
}

/** Everything under /admin/* goes through this: a valid token whose app_metadata.role is "admin". */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "unauthorized", "Missing bearer token");
  const claims = await verifyToken(token);
  if (claims.app_metadata?.role !== "admin") throw new ApiError(403, "forbidden", "Admin role required");
  c.set("adminId", claims.sub);
  await next();
};

const bearer = (header: string | undefined) => ((header ?? "").toLowerCase().startsWith("bearer ") ? header!.slice(7).trim() : "");

/** Creates the customer's profile row the first time we see them (the account itself lives in Supabase Auth). */
export async function ensureCustomer(q: Query, claims: AdminClaims): Promise<void> {
  const name = typeof claims.user_metadata?.full_name === "string" ? claims.user_metadata.full_name.trim().slice(0, 80) || null : null;
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase().slice(0, 200) || null : null;
  await q.query(`insert into public.customers (id, full_name, email) values ($1, $2, $3) on conflict (id) do update set email = coalesce(public.customers.email, excluded.email)`, [claims.sub, name, email]);
}

/** Everything under /me/* goes through this: any signed-in user (customers; admins may test their own profile too). */
export const requireUser: MiddlewareHandler = async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) throw new ApiError(401, "unauthorized", "Sign in first");
  const claims = await verifyToken(token);
  if (!claims.sub) throw new ApiError(401, "unauthorized", "Invalid token");
  await ensureCustomer(c.get("db"), claims);
  c.set("userId", claims.sub);
  c.set("userEmail", claims.email ?? "");
  await next();
};

/** For public endpoints that behave better when the visitor is signed in (e.g. placing an order). Never fails. */
export async function optionalUserId(header: string | undefined, q: Query): Promise<string | null> {
  const token = bearer(header);
  if (!token) return null;
  try {
    const claims = await verifyToken(token);
    if (!claims.sub) return null;
    await ensureCustomer(q, claims);
    return claims.sub;
  } catch {
    return null;
  }
}
