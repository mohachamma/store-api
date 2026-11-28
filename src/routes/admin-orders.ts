import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { LocaleQuery, pick, type Locale } from "../lib/i18n.js";
import { imageUrl } from "../lib/media.js";
import { getActiveProviderId } from "../lib/delivery/index.js";
import { toWhatsappNumber } from "../lib/orders.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 409: json(ErrorSchema, "Not allowed in the current status"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];

const Status = z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled", "returned"]);
const PaymentMethod = z.enum(["cod", "chargily"]);
const PaymentStatus = z.enum(["unpaid", "pending", "paid", "failed", "refunded"]);
const iso = (v: unknown) => (v ? new Date(v as string | number | Date).toISOString() : null);

const OrderRow = z
  .object({
    id: z.string().uuid(),
    orderNumber: z.number().int(),
    status: Status,
    paymentMethod: PaymentMethod,
    paymentStatus: PaymentStatus,
    deliveryType: z.enum(["home", "desk"]),
    wilayaCode: z.number().int(),
    wilaya: z.string(),
    total: z.number().int(),
    itemCount: z.number().int(),
    trackingNumber: z.string().nullable(),
    createdAt: z.string(),
    /** Only while the order is pending (personal data is erased on confirmation). */
    customerName: z.string().nullable(),
    customerPhone: z.string().nullable(),
  })
  .openapi("AdminOrderRow");

const OrderList = z.object({ items: z.array(OrderRow), total: z.number().int() }).openapi("AdminOrderList");

const OrderDetail = OrderRow.extend({
  subtotal: z.number().int(),
  shippingFee: z.number().int(),
  discountTotal: z.number().int(),
  discountCode: z.string().nullable(),
  deliveryCompany: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  items: z.array(z.object({ id: z.string().uuid(), name: z.string(), size: z.string(), color: z.string(), unitPrice: z.number().int(), quantity: z.number().int(), lineTotal: z.number().int() })),
  /** Present only while the order is pending. */
  customer: z.object({ name: z.string(), phone: z.string(), commune: z.string(), daira: z.string().nullable(), address: z.string(), whatsappUrl: z.string(), telUrl: z.string() }).nullable(),
}).openapi("AdminOrderDetail");

type Row = {
  id: string; order_number: string; status: z.infer<typeof Status>; payment_method: "cod" | "chargily"; payment_status: z.infer<typeof PaymentStatus>;
  delivery_type: "home" | "desk"; wilaya_code: number; name_ar: string; name_fr: string; total: number; item_count: number; tracking_number: string | null;
  created_at: unknown; customer_name: string | null; customer_phone: string | null;
};
const wname = (r: Row, locale: Locale) => (locale === "ar" ? r.name_ar : r.name_fr);
const rowOut = (r: Row, locale: Locale) => ({
  id: r.id, orderNumber: Number(r.order_number), status: r.status, paymentMethod: r.payment_method, paymentStatus: r.payment_status, deliveryType: r.delivery_type,
  wilayaCode: Number(r.wilaya_code), wilaya: wname(r, locale), total: Number(r.total), itemCount: Number(r.item_count), trackingNumber: r.tracking_number,
  createdAt: iso(r.created_at)!, customerName: r.customer_name, customerPhone: r.customer_phone,
});
const BASE_SELECT = `
  select o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.delivery_type, o.wilaya_code, w.name_ar, w.name_fr, o.total,
         (select coalesce(sum(i.quantity), 0)::int from public.order_items i where i.order_id = o.id) as item_count,
         o.tracking_number, o.created_at, o.customer_name, o.customer_phone
    from public.orders o join public.wilayas w on w.code = o.wilaya_code`;

export const adminOrderRoutes = new OpenAPIHono<AppEnv>();

adminOrderRoutes.openapi(
  createRoute({
    method: "get",
    path: "/admin/orders",
    tags: ["Admin"],
    security,
    summary: "Orders, newest first, with filters",
    request: {
      query: z.object({
        locale: LocaleQuery,
        status: Status.optional(),
        wilayaCode: z.coerce.number().int().min(1).max(58).optional(),
        paymentMethod: PaymentMethod.optional(),
        paymentStatus: PaymentStatus.optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        q: z.string().trim().max(60).optional().openapi({ description: "Order number or tracking number" }),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: { 200: json(OrderList, "OK"), ...errors },
  }),
  async (c) => {
    const f = c.req.valid("query");
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown) => (params.push(v), `$${params.length}`);
    if (f.status) where.push(`o.status = ${add(f.status)}`);
    if (f.wilayaCode) where.push(`o.wilaya_code = ${add(f.wilayaCode)}`);
    if (f.paymentMethod) where.push(`o.payment_method = ${add(f.paymentMethod)}`);
    if (f.paymentStatus) where.push(`o.payment_status = ${add(f.paymentStatus)}`);
    if (f.from) where.push(`o.created_at >= ${add(f.from)}`);
    if (f.to) where.push(`o.created_at < ${add(f.to)}`);
    if (f.q) {
      const digits = f.q.replace(/^#/, "");
      where.push(`(${/^\d+$/.test(digits) ? `o.order_number = ${add(digits)}::bigint or ` : ""}o.tracking_number ilike ${add(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`)})`);
    }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const db = c.get("db");
    const [rows, count] = await Promise.all([
      db.query<Row>(`${BASE_SELECT} ${w} order by o.created_at desc, o.id limit ${add(f.limit)} offset ${add(f.offset)}`, params),
      db.query<{ n: number }>(`select count(*)::int as n from public.orders o ${w}`, params.slice(0, params.length - 2)),
    ]);
    return c.json({ items: rows.map((r) => rowOut(r, f.locale)), total: Number(count[0]?.n ?? 0) }, 200);
  },
);

async function loadDetail(c: { get: (k: "db") => import("../lib/db.js").Db }, id: string, locale: Locale) {
  const db = c.get("db");
  const r = (await db.query<Row & { subtotal: number; shipping_fee: number; discount_total: number; code: string | null; delivery_company: string | null; delivery_status: string | null; confirmed_at: unknown; address: string | null; commune_ar: string | null; commune_fr: string | null; daira_ar: string | null; daira_fr: string | null }>(
    `select o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.delivery_type, o.wilaya_code, w.name_ar, w.name_fr, o.total,
            (select coalesce(sum(i.quantity), 0)::int from public.order_items i where i.order_id = o.id) as item_count,
            o.tracking_number, o.created_at, o.customer_name, o.customer_phone, o.subtotal, o.shipping_fee, o.discount_total, d.code,
            o.delivery_company, o.delivery_status, o.confirmed_at, o.address, cm.name_ar as commune_ar, cm.name_fr as commune_fr, cm.daira_ar, cm.daira_fr
       from public.orders o join public.wilayas w on w.code = o.wilaya_code
       left join public.discount_codes d on d.id = o.discount_code_id
       left join public.communes cm on cm.id = o.commune_id
      where o.id = $1`,
    [id],
  ))[0];
  if (!r) throw new ApiError(404, "not_found", "Order not found");
  const items = await db.query<{ id: string; product_name: string; size: string; color: string; unit_price: number; quantity: number; line_total: number }>(
    `select id, product_name, size, color, unit_price, quantity, line_total from public.order_items where order_id = $1 order by id`,
    [id],
  );
  const pending = r.status === "pending" && r.customer_phone;
  return {
    ...rowOut(r, locale),
    subtotal: Number(r.subtotal), shippingFee: Number(r.shipping_fee), discountTotal: Number(r.discount_total), discountCode: r.code,
    deliveryCompany: r.delivery_company, deliveryStatus: r.delivery_status, confirmedAt: iso(r.confirmed_at),
    items: items.map((i) => ({ id: i.id, name: i.product_name, size: i.size, color: i.color, unitPrice: Number(i.unit_price), quantity: Number(i.quantity), lineTotal: Number(i.line_total) })),
    customer: pending
      ? {
          name: r.customer_name!, phone: r.customer_phone!, commune: (locale === "ar" ? r.commune_ar : r.commune_fr) ?? "", daira: (locale === "ar" ? r.daira_ar : r.daira_fr) ?? null,
          address: r.address ?? "", whatsappUrl: `https://wa.me/${toWhatsappNumber(r.customer_phone!)}`, telUrl: `tel:${r.customer_phone}`,
        }
      : null,
  };
}

const IdParam = z.object({ id: z.string().uuid() });
const LocaleOnly = z.object({ locale: LocaleQuery });

adminOrderRoutes.openapi(
  createRoute({ method: "get", path: "/admin/orders/{id}", tags: ["Admin"], security, summary: "One order with its items (and the customer's contact details while it is pending)", request: { params: IdParam, query: LocaleOnly }, responses: { 200: json(OrderDetail, "OK"), ...errors } }),
  async (c) => c.json(await loadDetail(c, c.req.valid("param").id, c.req.valid("query").locale), 200),
);

adminOrderRoutes.openapi(
  createRoute({
    method: "post",
    path: "/admin/orders/{id}/confirm",
    tags: ["Admin"],
    security,
    summary: "Confirm a pending order. With a delivery company set up, the server sends the parcel to it and stores the tracking number; then the customer's personal data is erased. Without one, send the tracking number yourself.",
    request: { params: IdParam, query: LocaleOnly, body: body(z.object({ company: z.string().trim().min(1).max(60).default("manual"), trackingNumber: z.string().trim().min(1).max(60).optional() })) },
    responses: { 200: json(OrderDetail, "Confirmed"), 502: json(ErrorSchema, "Delivery company unavailable"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const db = c.get("db");
    if (!(await db.query(`select 1 from public.orders where id = $1`, [id])).length) throw new ApiError(404, "not_found", "Order not found");

    let company = b.company;
    let tracking = b.trackingNumber;
    let status = "created";
    if (!tracking) {
      const provider = c.get("delivery")[await getActiveProviderId(db)];
      if (!provider || provider.id === "manual") throw new ApiError(422, "tracking_required", "Enter the tracking number (no delivery company is set up)");
      if (!provider.configured()) throw new ApiError(409, "delivery_not_configured", `${provider.name} keys are not set on the server yet`);
      const o = (await db.query<{ status: string; order_number: string; delivery_type: "home" | "desk"; total: number; payment_status: string; customer_name: string | null; customer_phone: string | null; address: string | null; wilaya_fr: string; commune_fr: string | null }>(
        `select o.status, o.order_number, o.delivery_type, o.total, o.payment_status, o.customer_name, o.customer_phone, o.address, w.name_fr as wilaya_fr, cm.name_fr as commune_fr
           from public.orders o join public.wilayas w on w.code = o.wilaya_code left join public.communes cm on cm.id = o.commune_id where o.id = $1`,
        [id],
      ))[0]!;
      if (o.status !== "pending" || !o.customer_name) throw new ApiError(409, "conflict", "Only a pending order can be confirmed");
      const items = await db.query<{ product_name: string; size: string; color: string; quantity: number }>(`select product_name, size, color, quantity from public.order_items where order_id = $1`, [id]);
      let parcel;
      try {
        parcel = await provider.createParcel({
          orderNumber: Number(o.order_number),
          customerName: o.customer_name,
          phone: o.customer_phone!,
          address: o.address ?? "",
          wilayaName: o.wilaya_fr,
          communeName: o.commune_fr ?? "",
          deliveryType: o.delivery_type,
          amountToCollect: o.payment_status === "paid" ? 0 : Number(o.total),
          productList: items.map((i) => `${i.product_name} (${i.size}, ${i.color}) x${i.quantity}`).join(", ").slice(0, 250),
        });
      } catch (e) {
        // Log only the kind of failure, never the parcel (it holds the customer's data).
        console.error("Delivery company call failed:", (e as Error).name, (e as Error).message);
        throw new ApiError(502, "delivery_failed", `${provider.name} did not accept the parcel. Check the customer's address or try again.`);
      }
      company = provider.id;
      tracking = parcel.trackingNumber;
      status = parcel.status;
      try {
        await db.query(`select public.confirm_order($1, $2, $3, $4)`, [id, company, tracking, status]);
      } catch (e) {
        // The parcel exists at the company but we could not save it: cancel it so nothing is shipped twice.
        await provider.cancelParcel(tracking).catch(() => undefined);
        throw e;
      }
      return c.json(await loadDetail(c, id, c.req.valid("query").locale), 200);
    }
    // Manual tracking number: saved and personal data erased atomically in the database function.
    await db.query(`select public.confirm_order($1, $2, $3, $4)`, [id, company, tracking, status]);
    return c.json(await loadDetail(c, id, c.req.valid("query").locale), 200);
  },
);

const FLOW: Record<string, string[]> = { shipped: ["confirmed"], delivered: ["shipped"], returned: ["shipped", "delivered"], cancelled: ["pending", "confirmed"] };

adminOrderRoutes.openapi(
  createRoute({
    method: "post",
    path: "/admin/orders/{id}/status",
    tags: ["Admin"],
    security,
    summary: "Move an order forward: confirmed → shipped → delivered / returned (the goods go back to stock unless the profit settings say returned goods are lost), or cancel (restores the stock)",
    request: { params: IdParam, query: LocaleOnly, body: body(z.object({ status: z.enum(["shipped", "delivered", "returned", "cancelled"]) })) },
    responses: { 200: json(OrderDetail, "Updated"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const db = c.get("db");
    await db.tx(async (q) => {
      const cur = (await q.query<{ status: string }>(`select status from public.orders where id = $1 for update`, [id]))[0];
      if (!cur) throw new ApiError(404, "not_found", "Order not found");
      if (!FLOW[status]!.includes(cur.status)) throw new ApiError(409, "invalid_transition", `An order that is ${cur.status} cannot become ${status}`);
      if (status === "cancelled") {
        await q.query(`select public.cancel_order($1)`, [id]);
      } else {
        // Cash on delivery is paid when the parcel is delivered; a returned paid order is refunded.
        await q.query(
          `update public.orders set status = $2::public.order_status,
                  payment_status = case when $2 = 'delivered' and payment_method = 'cod' then 'paid'::public.payment_status
                                        when $2 = 'returned' and payment_status = 'paid' then 'refunded'::public.payment_status
                                        else payment_status end,
                  delivered_at = case when $2 = 'delivered' then now() else delivered_at end,
                  returned_at = case when $2 = 'returned' then now() else returned_at end
            where id = $1`,
          [id, status],
        );
        // A returned parcel goes back on the shelf (unless the owner says returned goods cannot be resold).
        if (status === "returned") {
          const lost = (await q.query<{ lost: boolean }>(`select coalesce((value->>'returned_items_lost')::boolean, false) as lost from public.site_settings where key = 'profit'`))[0]?.lost === true;
          if (!lost) {
            await q.query(`update public.product_variants v set stock = v.stock + i.quantity from public.order_items i where i.order_id = $1 and i.variant_id = v.id`, [id]);
          }
        }
      }
    });
    return c.json(await loadDetail(c, id, c.req.valid("query").locale), 200);
  },
);

// ---------------------------------------------------------------------------
// Statistics for the dashboard overview
// ---------------------------------------------------------------------------
const Overview = z
  .object({
    newOrdersToday: z.number().int(),
    revenue: z.object({ today: z.number().int(), week: z.number().int(), month: z.number().int() }),
    revenueLast7Days: z.array(z.number().int()),
    ordersByStatus: z.object({ pending: z.number().int(), confirmed: z.number().int(), shipped: z.number().int(), delivered: z.number().int(), cancelled: z.number().int(), returned: z.number().int() }),
    topProducts: z.array(z.object({ id: z.string(), name: z.string(), image: z.string(), unitsSold: z.number().int(), revenue: z.number().int() })),
    lowStock: z.array(z.object({ variantId: z.string(), productName: z.string(), size: z.string(), stock: z.number().int(), image: z.string() })),
  })
  .openapi("AdminOverview");

adminOrderRoutes.openapi(
  createRoute({ method: "get", path: "/admin/stats/overview", tags: ["Admin"], security, summary: "Dashboard numbers (days are counted in Algeria time). Revenue ignores cancelled and returned orders.", request: { query: LocaleOnly }, responses: { 200: json(Overview, "OK"), ...errors } }),
  async (c) => {
    const { locale } = c.req.valid("query");
    const db = c.get("db");
    const TZ = "Africa/Algiers";
    const day = `date_trunc('day', now() at time zone '${TZ}') at time zone '${TZ}'`;
    const live = `o.status not in ('cancelled', 'returned')`;
    const [totals, daily, byStatus, top, low] = await Promise.all([
      db.query<{ new_today: number; today: number; week: number; month: number }>(
        `select count(*) filter (where o.created_at >= ${day})::int as new_today,
                coalesce(sum(o.total) filter (where ${live} and o.created_at >= ${day}), 0)::int as today,
                coalesce(sum(o.total) filter (where ${live} and o.created_at >= ${day} - interval '6 days'), 0)::int as week,
                coalesce(sum(o.total) filter (where ${live} and o.created_at >= date_trunc('month', now() at time zone '${TZ}') at time zone '${TZ}'), 0)::int as month
           from public.orders o`,
      ),
      db.query<{ total: number }>(
        `select coalesce(sum(o.total) filter (where ${live}), 0)::int as total
           from generate_series(6, 0, -1) as g(n)
           left join public.orders o on o.created_at >= ${day} - make_interval(days => g.n) and o.created_at < ${day} - make_interval(days => g.n) + interval '1 day'
          group by g.n order by g.n desc`,
      ),
      db.query<{ status: string; n: number }>(`select status, count(*)::int as n from public.orders group by status`),
      db.query<{ id: string; name: unknown; image_path: string | null; units: number; revenue: number }>(
        `select p.id, p.name, img.path as image_path, sum(i.quantity)::int as units, sum(i.line_total)::int as revenue
           from public.order_items i
           join public.orders o on o.id = i.order_id and ${live} and o.created_at >= now() - interval '30 days'
           join public.product_variants v on v.id = i.variant_id join public.products p on p.id = v.product_id
           left join lateral (select path from public.product_images where product_id = p.id order by sort_order, id limit 1) img on true
          group by p.id, p.name, img.path order by units desc, revenue desc limit 5`,
      ),
      db.query<{ id: string; name: unknown; size: string; stock: number; image_path: string | null }>(
        `select v.id, p.name, v.size, v.stock, img.path as image_path
           from public.product_variants v join public.products p on p.id = v.product_id and p.is_published
           left join lateral (select path from public.product_images where product_id = p.id order by sort_order, id limit 1) img on true
          where v.stock <= 3 order by v.stock, p.name->>'ar' limit 8`,
      ),
    ]);
    const t = totals[0]!;
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
    const statuses = ["pending", "confirmed", "shipped", "delivered", "cancelled", "returned"] as const;
    return c.json(
      {
        newOrdersToday: Number(t.new_today),
        revenue: { today: Number(t.today), week: Number(t.week), month: Number(t.month) },
        revenueLast7Days: daily.map((d) => Number(d.total)),
        ordersByStatus: Object.fromEntries(statuses.map((s) => [s, counts[s] ?? 0])) as Record<(typeof statuses)[number], number>,
        topProducts: top.map((p) => ({ id: p.id, name: pick(p.name, locale), image: imageUrl(p.image_path) ?? "", unitsSold: Number(p.units), revenue: Number(p.revenue) })),
        lowStock: low.map((v) => ({ variantId: v.id, productName: pick(v.name, locale), size: v.size, stock: Number(v.stock), image: imageUrl(v.image_path) ?? "" })),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// Notifications: new-order events
// ---------------------------------------------------------------------------
const EventsOut = z
  .object({
    unreadCount: z.number().int(),
    items: z.array(z.object({ id: z.number().int(), type: z.string(), orderId: z.string().nullable(), orderNumber: z.number().int().nullable(), total: z.number().int().nullable(), createdAt: z.string(), read: z.boolean() })),
  })
  .openapi("AdminEvents");

adminOrderRoutes.openapi(
  createRoute({ method: "get", path: "/admin/events", tags: ["Admin"], security, summary: "Latest notifications (new orders) and the unread count", responses: { 200: json(EventsOut, "OK"), ...errors } }),
  async (c) => {
    const db = c.get("db");
    const [rows, unread] = await Promise.all([
      db.query<{ id: string; type: string; order_id: string | null; payload: { order_number?: number; total?: number }; created_at: unknown; read_at: unknown }>(
        `select id, type, order_id, payload, created_at, read_at from public.admin_events order by id desc limit 30`,
      ),
      db.query<{ n: number }>(`select count(*)::int as n from public.admin_events where read_at is null`),
    ]);
    return c.json(
      { unreadCount: Number(unread[0]?.n ?? 0), items: rows.map((e) => ({ id: Number(e.id), type: e.type, orderId: e.order_id, orderNumber: e.payload.order_number ?? null, total: e.payload.total ?? null, createdAt: iso(e.created_at)!, read: Boolean(e.read_at) })) },
      200,
    );
  },
);

adminOrderRoutes.openapi(
  createRoute({ method: "post", path: "/admin/events/read", tags: ["Admin"], security, summary: "Mark all notifications as read", responses: { 200: json(z.object({ ok: z.literal(true) }), "OK"), ...errors } }),
  async (c) => {
    await c.get("db").query(`update public.admin_events set read_at = now() where read_at is null`);
    return c.json({ ok: true as const }, 200);
  },
);
