import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Missing or invalid token"), 403: json(ErrorSchema, "Not an admin"), 404: json(ErrorSchema, "Not found"), 422: json(ErrorSchema, "Invalid input") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const iso = (v: unknown) => (v ? new Date(v as string | number | Date).toISOString() : null);
const like = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

const Stats = {
  orders: z.number().int().openapi({ description: "Orders placed (cancelled ones excluded)" }),
  delivered: z.number().int(),
  returned: z.number().int(),
  spent: z.number().int().openapi({ description: "Total of the delivered orders" }),
  lastOrderAt: z.string().nullable(),
};
const CustomerRow = z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable(), createdAt: z.string(), ...Stats, hasNote: z.boolean() }).openapi("AdminCustomerRow");
const CustomerList = z
  .object({
    items: z.array(CustomerRow),
    total: z.number().int(),
    guests: z.object({ orders: z.number().int(), delivered: z.number().int(), sales: z.number().int() }).openapi({ description: "Orders placed without an account. We keep no name or phone for them after the order is confirmed (privacy), so they cannot be listed." }),
  })
  .openapi("AdminCustomerList");
const CustomerDetail = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    whatsappUrl: z.string().nullable(),
    createdAt: z.string(),
    note: z.string(),
    favorites: z.number().int(),
    ...Stats,
    orderList: z.array(z.object({ id: z.string().uuid(), orderNumber: z.number().int(), status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled", "returned"]), total: z.number().int(), itemCount: z.number().int(), createdAt: z.string() })),
  })
  .openapi("AdminCustomerDetail");

const STATS_SQL = `
  count(o.id) filter (where o.status <> 'cancelled')::int as orders,
  count(o.id) filter (where o.status = 'delivered')::int as delivered,
  count(o.id) filter (where o.status = 'returned')::int as returned,
  coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as spent,
  max(o.created_at) filter (where o.status <> 'cancelled') as last_order_at`;

type StatRow = { orders: number; delivered: number; returned: number; spent: number; last_order_at: unknown };
const stats = (r: StatRow) => ({ orders: Number(r.orders), delivered: Number(r.delivered), returned: Number(r.returned), spent: Number(r.spent), lastOrderAt: iso(r.last_order_at) });

export const adminCustomerRoutes = new OpenAPIHono<AppEnv>();

adminCustomerRoutes.openapi(
  createRoute({
    method: "get",
    path: "/admin/customers",
    tags: ["Admin"],
    security,
    summary: "Customers who made an account, with their orders and spending (best spenders first), and a summary of the orders placed without an account",
    request: { query: z.object({ q: z.string().trim().max(80).optional(), sort: z.enum(["spent", "recent", "orders", "new"]).default("spent"), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }) },
    responses: { 200: json(CustomerList, "OK"), ...errors },
  }),
  async (c) => {
    const { q, sort, limit, offset } = c.req.valid("query");
    const db = c.get("db");
    const params: unknown[] = [];
    const where = q ? (params.push(like(q)), `where c.full_name ilike $1 or c.email ilike $1 or c.phone ilike $1`) : "";
    const order = { spent: "spent desc, orders desc", recent: "last_order_at desc nulls last", orders: "orders desc, spent desc", new: "c.created_at desc" }[sort];
    const [rows, count, guests] = await Promise.all([
      db.query<StatRow & { id: string; full_name: string | null; email: string | null; phone: string | null; created_at: unknown; has_note: boolean }>(
        `select c.id, c.full_name, c.email, c.phone, c.created_at, (c.admin_note is not null and c.admin_note <> '') as has_note, ${STATS_SQL}
           from public.customers c left join public.orders o on o.customer_id = c.id ${where}
          group by c.id order by ${order}, c.id limit ${limit} offset ${offset}`,
        params,
      ),
      db.query<{ n: number }>(`select count(*)::int as n from public.customers c ${where}`, params),
      db.query<{ orders: number; delivered: number; sales: number }>(
        `select count(*) filter (where status <> 'cancelled')::int as orders, count(*) filter (where status = 'delivered')::int as delivered,
                coalesce(sum(total) filter (where status = 'delivered'), 0)::int as sales
           from public.orders where customer_id is null`,
      ),
    ]);
    return c.json(
      {
        items: rows.map((r) => ({ id: r.id, name: r.full_name, email: r.email, phone: r.phone, createdAt: iso(r.created_at)!, ...stats(r), hasNote: r.has_note })),
        total: Number(count[0]?.n ?? 0),
        guests: { orders: Number(guests[0]?.orders ?? 0), delivered: Number(guests[0]?.delivered ?? 0), sales: Number(guests[0]?.sales ?? 0) },
      },
      200,
    );
  },
);

adminCustomerRoutes.openapi(
  createRoute({ method: "get", path: "/admin/customers/{id}", tags: ["Admin"], security, summary: "One customer: contact details, spending, orders, favorites count and the owner's private note", request: { params: z.object({ id: z.string().uuid() }) }, responses: { 200: json(CustomerDetail, "OK"), ...errors } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("db");
    const r = (
      await db.query<StatRow & { id: string; full_name: string | null; email: string | null; phone: string | null; created_at: unknown; admin_note: string | null; favorites: number }>(
        `select c.id, c.full_name, c.email, c.phone, c.created_at, c.admin_note, (select count(*)::int from public.favorites f where f.customer_id = c.id) as favorites, ${STATS_SQL}
           from public.customers c left join public.orders o on o.customer_id = c.id where c.id = $1 group by c.id`,
        [id],
      )
    )[0];
    if (!r) throw new ApiError(404, "not_found", "Customer not found");
    const orders = await db.query<{ id: string; order_number: string; status: "pending"; total: number; item_count: number; created_at: unknown }>(
      `select o.id, o.order_number, o.status, o.total, (select coalesce(sum(i.quantity), 0)::int from public.order_items i where i.order_id = o.id) as item_count, o.created_at
         from public.orders o where o.customer_id = $1 order by o.created_at desc limit 100`,
      [id],
    );
    const digits = (r.phone ?? "").replace(/\D/g, "");
    return c.json(
      {
        id: r.id, name: r.full_name, email: r.email, phone: r.phone,
        whatsappUrl: /^0[2-7]\d{7,8}$/.test(digits) ? `https://wa.me/213${digits.slice(1)}` : null,
        createdAt: iso(r.created_at)!, note: r.admin_note ?? "", favorites: Number(r.favorites), ...stats(r),
        orderList: orders.map((o) => ({ id: o.id, orderNumber: Number(o.order_number), status: o.status, total: Number(o.total), itemCount: Number(o.item_count), createdAt: iso(o.created_at)! })),
      },
      200,
    );
  },
);

adminCustomerRoutes.openapi(
  createRoute({
    method: "put",
    path: "/admin/customers/{id}/note",
    tags: ["Admin"],
    security,
    summary: "Save your private note about a customer (never shown to the customer)",
    request: { params: z.object({ id: z.string().uuid() }), body: body(z.object({ note: z.string().trim().max(500) })) },
    responses: { 200: json(Ok, "Saved"), ...errors },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { note } = c.req.valid("json");
    const r = await c.get("db").query(`update public.customers set admin_note = $2 where id = $1 returning id`, [id, note || null]);
    if (!r.length) throw new ApiError(404, "not_found", "Customer not found");
    return c.json({ ok: true as const }, 200);
  },
);
