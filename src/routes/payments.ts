import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });

const Methods = z.object({ cod: z.literal(true), card: z.boolean() }).openapi("PaymentMethods");
const Ok = z.object({ ok: z.literal(true) }).openapi("WebhookOk");

export const paymentRoutes = new OpenAPIHono<AppEnv>();

paymentRoutes.openapi(
  createRoute({ method: "get", path: "/payments/methods", tags: ["Payments"], summary: "Which payment methods checkout may offer (card only when Chargily is configured)", responses: { 200: json(Methods, "OK") } }),
  (c) => c.json({ cod: true as const, card: c.get("payment").configured() }, 200),
);

paymentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/chargily",
    tags: ["Payments"],
    summary: "Chargily calls this when a payment succeeds or fails (signature checked). Not for front-ends.",
    responses: { 200: json(Ok, "Processed"), 401: json(ErrorSchema, "Bad signature") },
  }),
  async (c) => {
    // The signature covers the exact bytes Chargily sent, so read the raw text.
    const raw = await c.req.raw.clone().text();
    const event = c.get("payment").parseWebhook(raw, c.req.header("signature"));
    if (event) {
      // A paid order stays paid; only an unpaid/pending/failed one can change.
      await c.get("db").query(
        `update public.orders set payment_status = $2 where payment_ref = $1 and payment_status in ('pending', 'failed', 'unpaid')`,
        [event.ref, event.status],
      );
    }
    return c.json({ ok: true as const }, 200);
  },
);
