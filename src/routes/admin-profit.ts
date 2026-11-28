import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getSetting } from "../lib/catalog.js";
import { LocaleQuery, pick, type Locale } from "../lib/i18n.js";
import { cleanTag } from "../lib/attribution.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const Id = z.object({ id: z.string().uuid() });
export const TZ = "Africa/Algiers";
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-31");
const Range = z.object({ from: DateStr.optional(), to: DateStr.optional() });
const ProfitQuery = Range.extend({ locale: LocaleQuery });

export const CATEGORIES = ["ads", "packaging", "salaries", "rent", "other"] as const;

export const adminProfitRoutes = new OpenAPIHono<AppEnv>();

// ---------------------------------------------------------------------------
// Settings used by the profit calculation
// ---------------------------------------------------------------------------
const ProfitSettings = z
  .object({
    returnFee: z.number().int().min(0).max(100_000),
    returnedItemsLost: z.boolean(),
    cardFeePercent: z.number().min(0).max(20),
  })
  .openapi("ProfitSettings");

export async function readSettings(db: AppEnv["Variables"]["db"]) {
  const v = ((await getSetting(db, "profit")) ?? {}) as { return_fee?: number; returned_items_lost?: boolean; card_fee_percent?: number };
  return { returnFee: Number(v.return_fee ?? 0), returnedItemsLost: v.returned_items_lost === true, cardFeePercent: Number(v.card_fee_percent ?? 0) };
}

adminProfitRoutes.openapi(
  createRoute({ method: "get", path: "/admin/profit-settings", tags: ["Admin"], security, summary: "Return fee, lost returned goods and card commission used in the profit calculation", responses: { 200: json(ProfitSettings, "OK"), ...errors } }),
  async (c) => c.json(await readSettings(c.get("db")), 200),
);

adminProfitRoutes.openapi(
  createRoute({ method: "put", path: "/admin/profit-settings", tags: ["Admin"], security, summary: "Save the profit settings", request: { body: body(ProfitSettings) }, responses: { 200: json(ProfitSettings, "Saved"), ...errors } }),
  async (c) => {
    const v = c.req.valid("json");
    await c.get("db").query(`insert into public.site_settings (key, value) values ('profit', $1::jsonb) on conflict (key) do update set value = excluded.value`, [
      JSON.stringify({ return_fee: v.returnFee, returned_items_lost: v.returnedItemsLost, card_fee_percent: v.cardFeePercent }),
    ]);
    return c.json(v, 200);
  },
);

// ---------------------------------------------------------------------------
// Expenses (ads, packaging, salaries, rent, other)
// ---------------------------------------------------------------------------
const Expense = z
  .object({
    id: z.string().uuid(),
    spentOn: DateStr,
    category: z.enum(CATEGORIES),
    platform: z.string().nullable(),
    /** Ads only: the campaign this spend belongs to (the same name as in the ad link), so the ads report can compare spend and sales. */
    campaign: z.string().nullable(),
    amount: z.number().int(),
    note: z.string().nullable(),
  })
  .openapi("Expense");
const ExpenseInput = z
  .object({
    spentOn: DateStr,
    category: z.enum(CATEGORIES),
    platform: z.string().trim().max(40).nullable().default(null),
    campaign: z.string().trim().max(80).nullable().default(null),
    amount: z.number().int().min(1).max(100_000_000),
    note: z.string().trim().max(200).nullable().default(null),
  })
  .openapi("ExpenseInput");

type ExpenseRow = { id: string; spent_on: string; category: (typeof CATEGORIES)[number]; platform: string | null; campaign: string | null; amount: number; note: string | null };
const EXPENSE_COLS = `id, to_char(spent_on, 'YYYY-MM-DD') as spent_on, category, platform, campaign, amount, note`;
const toExpense = (r: ExpenseRow) => ({ id: r.id, spentOn: r.spent_on, category: r.category, platform: r.platform || null, campaign: r.campaign || null, amount: Number(r.amount), note: r.note || null });

/** Default period = this month so far (Algeria time). */
export const FROM_DEFAULT = `date_trunc('month', now() at time zone '${TZ}')::date`;
export const TO_DEFAULT = `(now() at time zone '${TZ}')::date`;

adminProfitRoutes.openapi(
  createRoute({ method: "get", path: "/admin/expenses", tags: ["Admin"], security, summary: "Expenses in a period (default: this month)", request: { query: Range }, responses: { 200: json(z.array(Expense), "OK"), ...errors } }),
  async (c) => {
    const { from, to } = c.req.valid("query");
    const rows = await c.get("db").query<ExpenseRow>(
      `select ${EXPENSE_COLS} from public.expenses where spent_on between coalesce($1::date, ${FROM_DEFAULT}) and coalesce($2::date, ${TO_DEFAULT}) order by spent_on desc, created_at desc limit 500`,
      [from ?? null, to ?? null],
    );
    return c.json(rows.map(toExpense), 200);
  },
);

adminProfitRoutes.openapi(
  createRoute({ method: "post", path: "/admin/expenses", tags: ["Admin"], security, summary: "Record an expense", request: { body: body(ExpenseInput) }, responses: { 201: json(Expense, "Created"), ...errors } }),
  async (c) => {
    const v = c.req.valid("json");
    const rows = await c.get("db").query<ExpenseRow>(
      `insert into public.expenses (spent_on, category, platform, campaign, amount, note) values ($1, $2, $3, $4, $5, $6) returning ${EXPENSE_COLS}`,
      [v.spentOn, v.category, cleanTag(v.platform), cleanTag(v.campaign, 80), v.amount, v.note || null],
    );
    return c.json(toExpense(rows[0]!), 201);
  },
);

adminProfitRoutes.openapi(
  createRoute({ method: "put", path: "/admin/expenses/{id}", tags: ["Admin"], security, summary: "Edit an expense", request: { params: Id, body: body(ExpenseInput) }, responses: { 200: json(Expense, "Saved"), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const v = c.req.valid("json");
    const rows = await c.get("db").query<ExpenseRow>(
      `update public.expenses set spent_on = $2, category = $3, platform = $4, campaign = $5, amount = $6, note = $7 where id = $1 returning ${EXPENSE_COLS}`,
      [id, v.spentOn, v.category, cleanTag(v.platform), cleanTag(v.campaign, 80), v.amount, v.note || null],
    );
    if (!rows.length) throw new ApiError(404, "not_found", "Expense not found");
    return c.json(toExpense(rows[0]!), 200);
  },
);

adminProfitRoutes.openapi(
  createRoute({ method: "delete", path: "/admin/expenses/{id}", tags: ["Admin"], security, summary: "Delete an expense", request: { params: Id }, responses: { 200: json(Ok, "Deleted"), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    if (!(await c.get("db").query(`delete from public.expenses where id = $1 returning id`, [id])).length) throw new ApiError(404, "not_found", "Expense not found");
    return c.json({ ok: true as const }, 200);
  },
);

// ---------------------------------------------------------------------------
// Net profit report
// ---------------------------------------------------------------------------
const ProfitReport = z
  .object({
    from: DateStr,
    to: DateStr,
    delivered: z.object({
      orders: z.number().int(),
      sales: z.number().int().openapi({ description: "Goods sold, after discount codes (without delivery fees)" }),
      shippingCollected: z.number().int().openapi({ description: "Delivery fees paid by customers" }),
      productCost: z.number().int().openapi({ description: "What the sold goods cost us" }),
      deliveryCost: z.number().int().openapi({ description: "What the delivery company charged us" }),
      cardFees: z.number().int().openapi({ description: "Commission on card payments" }),
    }),
    returned: z.object({
      orders: z.number().int(),
      deliveryLoss: z.number().int().openapi({ description: "Delivery fees paid for parcels that came back" }),
      returnFees: z.number().int(),
      lostGoods: z.number().int().openapi({ description: "Cost of returned goods that cannot be resold (only when the setting says so)" }),
    }),
    expenses: z.object({ total: z.number().int(), byCategory: z.array(z.object({ category: z.enum(CATEGORIES), amount: z.number().int() })) }),
    netProfit: z.number().int(),
    returnRatePercent: z.number().int().openapi({ description: "Returned parcels out of delivered + returned" }),
    warnings: z.object({ itemsWithoutCost: z.number().int(), activeWilayasWithoutDeliveryCost: z.number().int() }),
    byProduct: z
      .array(
        z.object({
          key: z.string(),
          name: z.string(),
          unitsSold: z.number().int(),
          unitsReturned: z.number().int(),
          sales: z.number().int(),
          productCost: z.number().int(),
          deliveryCost: z.number().int().openapi({ description: "Share of the delivery cost of the parcels that carried this product" }),
          returnLoss: z.number().int().openapi({ description: "Share of what the returned parcels cost (delivery + return fee [+ goods if lost]); this is the return cost carried by the product even when it is resold later" }),
          profit: z.number().int().openapi({ description: "Before ads, other expenses and card fees" }),
        }),
      )
      .openapi({ description: "Profit per product, best first. Order-level amounts (delivery fees, delivery cost, discounts, return costs) are shared between the products of a parcel in proportion to their value." }),
  })
  .openapi("ProfitReport");

adminProfitRoutes.openapi(
  createRoute({
    method: "get",
    path: "/admin/profit",
    tags: ["Admin"],
    security,
    summary:
      "Net profit for a period (default: this month, Algeria time). Counts parcels by the day they were delivered or returned: " +
      "sales + delivery fees collected − product cost − delivery cost − card fees − losses on returns − expenses.",
    request: { query: ProfitQuery },
    responses: { 200: json(ProfitReport, "OK"), ...errors },
  }),
  async (c) => {
    const db = c.get("db");
    const { from, to, locale } = c.req.valid("query");
    const range = (await db.query<{ f: string; t: string }>(`select to_char(coalesce($1::date, ${FROM_DEFAULT}), 'YYYY-MM-DD') as f, to_char(coalesce($2::date, ${TO_DEFAULT}), 'YYYY-MM-DD') as t`, [from ?? null, to ?? null]))[0]!;
    if (range.f > range.t) throw new ApiError(422, "invalid_range", "The start date is after the end date");
    const p = [range.f, range.t];
    const delivered = `o.status = 'delivered' and (coalesce(o.delivered_at, o.updated_at) at time zone '${TZ}')::date between $1::date and $2::date`;
    const returned = `o.status = 'returned' and (coalesce(o.returned_at, o.updated_at) at time zone '${TZ}')::date between $1::date and $2::date`;

    const lineShare = `i.line_total::numeric / nullif(o.subtotal, 0)`;
    const productKey = `coalesce(v.product_id::text, i.product_name)`;
    const settings = await readSettings(db);
    const [d, dItems, r, rItems, ex, wil, dProducts, rProducts] = await Promise.all([
      db.query<{ n: number; sales: number; shipping: number; delivery: number; card: number }>(
        `select count(*)::int as n, coalesce(sum(o.subtotal - o.discount_total), 0)::int as sales, coalesce(sum(o.shipping_fee), 0)::int as shipping,
                coalesce(sum(o.delivery_cost), 0)::int as delivery, coalesce(sum(o.total) filter (where o.payment_method = 'chargily'), 0)::int as card
           from public.orders o where ${delivered}`, p),
      db.query<{ cost: number; missing: number }>(
        `select coalesce(sum(i.unit_cost * i.quantity), 0)::int as cost, count(*) filter (where i.unit_cost is null)::int as missing
           from public.order_items i join public.orders o on o.id = i.order_id where ${delivered}`, p),
      db.query<{ n: number; delivery: number }>(`select count(*)::int as n, coalesce(sum(o.delivery_cost), 0)::int as delivery from public.orders o where ${returned}`, p),
      db.query<{ cost: number }>(`select coalesce(sum(i.unit_cost * i.quantity), 0)::int as cost from public.order_items i join public.orders o on o.id = i.order_id where ${returned}`, p),
      db.query<{ category: (typeof CATEGORIES)[number]; amount: number }>(`select category, sum(amount)::int as amount from public.expenses where spent_on between $1::date and $2::date group by category order by amount desc`, p),
      db.query<{ n: number }>(`select count(*)::int as n from public.wilayas where active and home_cost = 0 and desk_cost = 0`),
      db.query<{ key: string; name: unknown; fallback: string; units: number; sales: number; cost: number; delivery: number; shipping: number }>(
        `select ${productKey} as key, max(p.name::text)::jsonb as name, max(i.product_name) as fallback, sum(i.quantity)::int as units,
                sum(i.line_total - o.discount_total * ${lineShare}) as sales,
                sum(coalesce(i.unit_cost, 0) * i.quantity) as cost,
                sum(o.delivery_cost * ${lineShare}) as delivery,
                sum(o.shipping_fee * ${lineShare}) as shipping
           from public.order_items i join public.orders o on o.id = i.order_id
           left join public.product_variants v on v.id = i.variant_id left join public.products p on p.id = v.product_id
          where ${delivered} group by 1`, p),
      db.query<{ key: string; name: unknown; fallback: string; units: number; delivery: number; goods: number }>(
        `select ${productKey} as key, max(p.name::text)::jsonb as name, max(i.product_name) as fallback, sum(i.quantity)::int as units,
                sum((o.delivery_cost + $3) * ${lineShare}) as delivery,
                sum(coalesce(i.unit_cost, 0) * i.quantity) as goods
           from public.order_items i join public.orders o on o.id = i.order_id
           left join public.product_variants v on v.id = i.variant_id left join public.products p on p.id = v.product_id
          where ${returned} group by 1`, [...p, settings.returnFee]),
    ]);

    const dr = d[0]!;
    const cardFees = Math.round((Number(dr.card) * settings.cardFeePercent) / 100);
    const returnedCount = Number(r[0]!.n);
    const returnFees = returnedCount * settings.returnFee;
    const lostGoods = settings.returnedItemsLost ? Number(rItems[0]!.cost) : 0;
    const deliveryLoss = Number(r[0]!.delivery);
    const expensesTotal = ex.reduce((n, e) => n + Number(e.amount), 0);
    const productCost = Number(dItems[0]!.cost);
    const net = Number(dr.sales) + Number(dr.shipping) - productCost - Number(dr.delivery) - cardFees - deliveryLoss - returnFees - lostGoods - expensesTotal;
    const parcels = Number(dr.n) + returnedCount;

    // Profit per product: the return cost of a returned parcel stays with its products, even when they are resold in another order.
    const prod = new Map<string, { name: string; sold: number; returned: number; sales: number; cost: number; delivery: number; shipping: number; returnLoss: number }>();
    const entry = (key: string, name: unknown, fallback: string) => {
      let e = prod.get(key);
      if (!e) prod.set(key, (e = { name: name ? pick(name, locale as Locale) || fallback : fallback, sold: 0, returned: 0, sales: 0, cost: 0, delivery: 0, shipping: 0, returnLoss: 0 }));
      return e;
    };
    for (const x of dProducts) Object.assign(entry(x.key, x.name, x.fallback), { sold: Number(x.units), sales: Number(x.sales), cost: Number(x.cost), delivery: Number(x.delivery), shipping: Number(x.shipping) });
    for (const x of rProducts) {
      const e = entry(x.key, x.name, x.fallback);
      e.returned = Number(x.units);
      // delivery already paid + the return fee, shared by value between the parcel's products [+ the goods if they cannot be resold]
      e.returnLoss = Number(x.delivery) + (settings.returnedItemsLost ? Number(x.goods) : 0);
    }
    const byProduct = [...prod].map(([key, e]) => ({
      key,
      name: e.name,
      unitsSold: e.sold,
      unitsReturned: e.returned,
      sales: Math.round(e.sales),
      productCost: Math.round(e.cost),
      deliveryCost: Math.round(e.delivery),
      returnLoss: Math.round(e.returnLoss),
      profit: Math.round(e.sales + e.shipping - e.cost - e.delivery - e.returnLoss),
    })).sort((a, b) => b.profit - a.profit).slice(0, 100);

    return c.json(
      {
        from: range.f,
        to: range.t,
        delivered: { orders: Number(dr.n), sales: Number(dr.sales), shippingCollected: Number(dr.shipping), productCost, deliveryCost: Number(dr.delivery), cardFees },
        returned: { orders: returnedCount, deliveryLoss, returnFees, lostGoods },
        expenses: { total: expensesTotal, byCategory: ex.map((e) => ({ category: e.category, amount: Number(e.amount) })) },
        netProfit: net,
        returnRatePercent: parcels ? Math.round((returnedCount / parcels) * 100) : 0,
        warnings: { itemsWithoutCost: Number(dItems[0]!.missing), activeWilayasWithoutDeliveryCost: Number(wil[0]!.n) },
        byProduct,
      },
      200,
    );
  },
);
