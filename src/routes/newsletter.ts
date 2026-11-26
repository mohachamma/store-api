import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

export const newsletterRoutes = new OpenAPIHono<AppEnv>();

newsletterRoutes.openapi(
  createRoute({
    method: "post",
    path: "/newsletter",
    tags: ["Newsletter"],
    summary: "Subscribe an email to the newsletter (same answer whether or not it was already subscribed)",
    request: { body: { required: true, content: { "application/json": { schema: z.object({ email: z.string().trim().toLowerCase().email().max(200) }) } } } },
    responses: {
      200: { description: "Subscribed", content: { "application/json": { schema: z.object({ ok: z.literal(true) }).openapi("NewsletterOk") } } },
      422: { description: "Invalid email", content: { "application/json": { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    await c.get("db").query(`insert into public.newsletter_subscribers (email) values ($1) on conflict (email) do nothing`, [c.req.valid("json").email]);
    return c.json({ ok: true as const }, 200);
  },
);
