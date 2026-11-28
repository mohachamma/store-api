import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";
import { DateStr, FROM_DEFAULT, readSettings, TO_DEFAULT } from "./admin-profit.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];

const Campaign = z.object({
  source: z.string().openapi({ description: "Platform (facebook, tiktok…); empty for orders without ad tags" }),
  campaign: z.string().openapi({ description: "Campaign name; empty when the ad link had none" }),
  orders: z.number().int().openapi({ description: "Orders placed in the period (cancelled ones excluded)" }),
  delivered: z.number().int(),
  returned: z.number().int(),
  inProgress: z.number().int().openapi({ description: "Pending, confirmed or shipped: not counted in the money yet" }),
  sales: z.number().int().openapi({ description: "Delivered orders: goods + delivery fees collected" }),
  profit: z.number().int().openapi({ description: "Delivered sales − product cost − delivery cost − return losses, before the ad spend" }),
  spend: z.number().int().openapi({ description: "Ad expenses of the period with the same platform and campaign" }),
  netProfit: z.number().int().openapi({ description: "profit − spend" }),
  roas: z.number().nullable().openapi({ description: "Sales ÷ spend (2 = every 1 DA of ads brought 2 DA of sales); null without spend" }),
  costPerOrder: z.number().int().nullable().openapi({ description: "spend ÷ orders" }),
});

const AdsReport = z
  .object({
    from: DateStr,
    to: DateStr,
    campaigns: z.array(Campaign).openapi({ description: "Best net profit first. The row with an empty source and campaign is the orders that came without any ad tag." }),
    totals: z.object({ orders: z.number().int(), sales: z.number().int(), profit: z.number().int(), spend: z.number().int(), netProfit: z.number().int() }),
  })
  .openapi("AdsReport");

export const adminAdsRoutes = new OpenAPIHono<AppEnv>();

adminAdsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/admin/ads",
    tags: ["Admin"],
    security,
    summary:
      "Results per ad campaign for the orders placed in a period (default: this month, Algeria time): orders, delivered / returned, sales, profit before ads, ad spend (expenses with the same platform and campaign), net profit, return on ad spend.",
    request: { query: z.object({ from: DateStr.optional(), to: DateStr.optional() }) },
    responses: { 200: json(AdsReport, "OK"), ...errors },
  }),
  async (c) => {
    const db = c.get("db");
    const { from, to } = c.req.valid("query");
    const range = (await db.query<{ f: string; t: string }>(`select to_char(coalesce($1::date, ${FROM_DEFAULT}), 'YYYY-MM-DD') as f, to_char(coalesce($2::date, ${TO_DEFAULT}), 'YYYY-MM-DD') as t`, [from ?? null, to ?? null]))[0]!;
    if (range.f > range.t) throw new ApiError(422, "invalid_range", "The start date is after the end date");
    const settings = await readSettings(db);
    const lostGoods = settings.returnedItemsLost;

    const [orders, spend] = await Promise.all([
      db.query<{ source: string; campaign: string; orders: number; delivered: number; returned: number; in_progress: number; revenue: number; cost: number; delivery: number; return_loss: number; returned_goods: number }>(
        `select coalesce(o.ad_source, '') as source, coalesce(o.ad_campaign, '') as campaign,
                count(*)::int as orders,
                count(*) filter (where o.status = 'delivered')::int as delivered,
                count(*) filter (where o.status = 'returned')::int as returned,
                count(*) filter (where o.status in ('pending', 'confirmed', 'shipped'))::int as in_progress,
                coalesce(sum(o.subtotal - o.discount_total + o.shipping_fee) filter (where o.status = 'delivered'), 0)::int as revenue,
                coalesce(sum(o.cost) filter (where o.status = 'delivered'), 0)::int as cost,
                coalesce(sum(o.delivery_cost) filter (where o.status = 'delivered'), 0)::int as delivery,
                coalesce(sum(o.delivery_cost + $3) filter (where o.status = 'returned'), 0)::int as return_loss,
                coalesce(sum(o.cost) filter (where o.status = 'returned'), 0)::int as returned_goods
           from (select x.*, (select coalesce(sum(i.unit_cost * i.quantity), 0) from public.order_items i where i.order_id = x.id) as cost
                   from public.orders x
                  where x.status <> 'cancelled' and (x.created_at at time zone 'Africa/Algiers')::date between $1::date and $2::date) o
          group by 1, 2`,
        [range.f, range.t, settings.returnFee],
      ),
      db.query<{ source: string; campaign: string; amount: number }>(
        `select coalesce(platform, '') as source, coalesce(campaign, '') as campaign, sum(amount)::int as amount
           from public.expenses where category = 'ads' and spent_on between $1::date and $2::date group by 1, 2`,
        [range.f, range.t],
      ),
    ]);

    const rows = new Map<string, z.infer<typeof Campaign>>();
    const row = (source: string, campaign: string) => {
      const k = `${source}|${campaign}`;
      let r = rows.get(k);
      if (!r) rows.set(k, (r = { source, campaign, orders: 0, delivered: 0, returned: 0, inProgress: 0, sales: 0, profit: 0, spend: 0, netProfit: 0, roas: null, costPerOrder: null }));
      return r;
    };
    for (const o of orders) {
      Object.assign(row(o.source, o.campaign), {
        orders: Number(o.orders), delivered: Number(o.delivered), returned: Number(o.returned), inProgress: Number(o.in_progress), sales: Number(o.revenue),
        profit: Number(o.revenue) - Number(o.cost) - Number(o.delivery) - Number(o.return_loss) - (lostGoods ? Number(o.returned_goods) : 0),
      });
    }
    // Ad spend with no orders still shows up, so the totals add up.
    for (const s of spend) row(s.source, s.campaign).spend = Number(s.amount);

    const campaigns = [...rows.values()].map((r) => ({
      ...r,
      netProfit: r.profit - r.spend,
      roas: r.spend > 0 ? Math.round((r.sales / r.spend) * 100) / 100 : null,
      costPerOrder: r.spend > 0 && r.orders > 0 ? Math.round(r.spend / r.orders) : null,
    })).sort((a, b) => b.netProfit - a.netProfit);
    const sum = (f: (r: (typeof campaigns)[number]) => number) => campaigns.reduce((n, r) => n + f(r), 0);
    return c.json({ from: range.f, to: range.t, campaigns, totals: { orders: sum((r) => r.orders), sales: sum((r) => r.sales), profit: sum((r) => r.profit), spend: sum((r) => r.spend), netProfit: sum((r) => r.netProfit) } }, 200);
  },
);
