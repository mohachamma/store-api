import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { MiddlewareHandler } from "hono";
import { getEnv } from "../env.js";
import { ApiError } from "./errors.js";

export interface AdminClaims extends JWTPayload {
  app_metadata?: { role?: string };
  email?: string;
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
