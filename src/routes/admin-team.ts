import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 409: json(ErrorSchema, "Conflict"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];

const TeamMember = z.object({ id: z.string(), email: z.string(), createdAt: z.string().nullable(), lastSignInAt: z.string().nullable(), isYou: z.boolean() }).openapi("TeamMember");

export const adminTeamRoutes = new OpenAPIHono<AppEnv>();

adminTeamRoutes.openapi(
  createRoute({ method: "get", path: "/admin/admins", tags: ["Admin"], security, summary: "Everyone who can open the dashboard", responses: { 200: json(z.array(TeamMember), "OK"), ...errors } }),
  async (c) => {
    const me = c.get("adminId");
    const list = await c.get("admins").list();
    return c.json(list.sort((a, b) => a.email.localeCompare(b.email)).map((u) => ({ ...u, isYou: u.id === me })), 200);
  },
);

adminTeamRoutes.openapi(
  createRoute({
    method: "post",
    path: "/admin/admins",
    tags: ["Admin"],
    security,
    summary: "Give someone access to the dashboard: a new account gets an invitation email, an existing account is promoted. Their open sessions change within the hour.",
    request: { body: body(z.object({ email: z.string().trim().toLowerCase().email().max(200) })) },
    responses: { 201: json(TeamMember, "Invited"), ...errors },
  }),
  async (c) => {
    const { email } = c.req.valid("json");
    const u = await c.get("admins").invite(email);
    return c.json({ ...u, isYou: u.id === c.get("adminId") }, 201);
  },
);

adminTeamRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/admin/admins/{id}",
    tags: ["Admin"],
    security,
    summary: "Take dashboard access away (the account stays as a normal customer). You cannot remove yourself or the last admin.",
    request: { params: z.object({ id: z.string().min(1).max(60) }) },
    responses: { 200: json(z.object({ ok: z.literal(true) }).openapi("Ok"), "Removed"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    if (id === c.get("adminId")) throw new ApiError(409, "conflict", "You cannot remove your own access");
    const admins = c.get("admins");
    const list = await admins.list();
    if (!list.some((u) => u.id === id)) throw new ApiError(404, "not_found", "This person is not an admin");
    if (list.length <= 1) throw new ApiError(409, "conflict", "There must be at least one admin");
    await admins.demote(id);
    return c.json({ ok: true as const }, 200);
  },
);
