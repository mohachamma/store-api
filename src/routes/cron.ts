import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getEnv } from "../env.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { syncTracking } from "../lib/tracking.js";
import type { AppEnv } from "../lib/types.js";

const Result = z.object({ expiredOrders: z.number().int(), deletedEvents: z.number().int(), trackingUpdated: z.number().int() }).openapi("CleanupResult");

export const cronRoutes = new OpenAPIHono<AppEnv>();

cronRoutes.openapi(
  createRoute({
    method: "get",
    path: "/cron/cleanup",
    tags: ["Cron"],
    summary: "Daily cleanup (Vercel Cron): cancel orders left pending too long, delete old notifications, refresh parcel statuses",
    responses: { 200: { description: "Done", content: { "application/json": { schema: Result } } }, 401: { description: "Wrong secret", content: { "application/json": { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const secret = getEnv().CRON_SECRET;
    if (!secret || c.req.header("authorization") !== `Bearer ${secret}`) throw new ApiError(401, "unauthorized", "Not allowed");
    const db = c.get("db");
    const expired = await db.query<{ n: number }>(`select public.expire_pending_orders(14) as n`);
    const events = await db.query<{ id: string }>(`delete from public.admin_events where created_at < now() - interval '60 days' returning id`);
    // Refresh the status of parcels still on the road (at most 100 per run, one company call each).
    const open = await db.query<{ id: string; status: string; delivery_company: string; tracking_number: string }>(
      `select id, status, delivery_company, tracking_number from public.orders where status in ('confirmed', 'shipped') and tracking_number is not null and delivery_company is not null and delivery_company <> 'manual' order by updated_at limit 100`,
    );
    let updated = 0;
    for (const o of open) {
      try {
        // Saves the company's status and moves the order (shipped / delivered / returned) when the company says so.
        if (await syncTracking(db, c.get("delivery"), o)) updated++;
      } catch {
        // One failing parcel must not stop the others.
      }
    }
    return c.json({ expiredOrders: Number(expired[0]?.n ?? 0), deletedEvents: events.length, trackingUpdated: updated }, 200);
  },
);
