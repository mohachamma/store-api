import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getActiveProviderId } from "../lib/delivery/index.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 409: json(ErrorSchema, "Conflict"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];

const DeliverySettings = z
  .object({
    provider: z.string(),
    providers: z.array(z.object({ id: z.string(), name: z.string(), configured: z.boolean() })),
  })
  .openapi("AdminDelivery");

export const adminDeliveryRoutes = new OpenAPIHono<AppEnv>();

async function current(c: { get: (k: "db" | "delivery") => never }) {
  const db = c.get("db") as import("../lib/db.js").Db;
  const all = c.get("delivery") as import("../lib/types.js").AppEnv["Variables"]["delivery"];
  return { provider: await getActiveProviderId(db), providers: Object.values(all).map((p) => ({ id: p.id, name: p.name, configured: p.configured() })) };
}

adminDeliveryRoutes.openapi(
  createRoute({ method: "get", path: "/admin/delivery", tags: ["Admin"], security, summary: "Delivery company in use and the ones available", responses: { 200: json(DeliverySettings, "OK"), ...errors } }),
  async (c) => c.json(await current(c as never), 200),
);

adminDeliveryRoutes.openapi(
  createRoute({
    method: "put",
    path: "/admin/delivery",
    tags: ["Admin"],
    security,
    summary: "Choose the delivery company. New confirmations use it at once; parcels already sent stay with their company.",
    request: { body: body(z.object({ provider: z.string().min(1).max(40) })) },
    responses: { 200: json(DeliverySettings, "Saved"), ...errors },
  }),
  async (c) => {
    const { provider } = c.req.valid("json");
    const p = c.get("delivery")[provider];
    if (!p) throw new ApiError(422, "unknown_provider", "Unknown delivery company");
    if (!p.configured()) throw new ApiError(409, "delivery_not_configured", `${p.name} keys are not set on the server yet`);
    await c.get("db").query(
      `insert into public.site_settings (key, value) values ('delivery', $1::jsonb) on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ provider })],
    );
    return c.json(await current(c as never), 200);
  },
);

adminDeliveryRoutes.openapi(
  createRoute({
    method: "post",
    path: "/admin/orders/{id}/refresh-tracking",
    tags: ["Admin"],
    security,
    summary: "Ask the delivery company for the parcel's current status and save it",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: { 200: json(z.object({ deliveryStatus: z.string() }).openapi("DeliveryStatus"), "OK"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const o = (await db.query<{ delivery_company: string | null; tracking_number: string | null }>(`select delivery_company, tracking_number from public.orders where id = $1`, [id]))[0];
    if (!o) throw new ApiError(404, "not_found", "Order not found");
    const p = o.delivery_company ? c.get("delivery")[o.delivery_company] : undefined;
    if (!p || p.id === "manual" || !o.tracking_number) throw new ApiError(409, "conflict", "This order has no delivery company to ask");
    if (!p.configured()) throw new ApiError(409, "delivery_not_configured", `${p.name} keys are not set on the server yet`);
    try {
      const t = await p.getTracking(o.tracking_number);
      await db.query(`update public.orders set delivery_status = $2 where id = $1`, [id, t.status]);
      return c.json({ deliveryStatus: t.status }, 200);
    } catch (e) {
      console.error("Tracking refresh failed:", (e as Error).name);
      throw new ApiError(502, "delivery_failed", `${p.name} did not answer. Try again later.`);
    }
  },
);
