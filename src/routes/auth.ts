import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getEnv } from "../env.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).openapi("LoginBody");
const LoginResult = z
  .object({
    accessToken: z.string(),
    /** Seconds until the token expires. */
    expiresIn: z.number().int(),
    user: z.object({ id: z.string(), email: z.string(), role: z.enum(["admin", "customer"]) }),
  })
  .openapi("LoginResult");

export const authRoutes = new OpenAPIHono<AppEnv>();

/**
 * Password login through Supabase Auth. The role comes from the user's app_metadata
 * (set only by the project owner / the API); the dashboard refuses anyone who is not "admin".
 */
authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/auth/login",
    tags: ["Auth"],
    summary: "Sign in with email and password",
    request: { body: { required: true, content: { "application/json": { schema: LoginBody } } } },
    responses: {
      200: { description: "Signed in", content: { "application/json": { schema: LoginResult } } },
      401: { description: "Wrong email or password", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { email, password } = c.req.valid("json");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = getEnv();
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new ApiError(503, "service_unavailable", "Authentication is not configured");

    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 422) throw new ApiError(401, "invalid_credentials", "Wrong email or password");
    if (!res.ok) throw new ApiError(502, "auth_unavailable", "Authentication service error");

    const body = (await res.json()) as { access_token: string; expires_in: number; user: { id: string; email: string; app_metadata?: { role?: string } } };
    const role = body.user.app_metadata?.role === "admin" ? ("admin" as const) : ("customer" as const);
    return c.json({ accessToken: body.access_token, expiresIn: body.expires_in, user: { id: body.user.id, email: body.user.email, role } }, 200);
  },
);
