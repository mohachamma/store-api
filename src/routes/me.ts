import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { SUMMARY_SQL, toSummary, type SummaryRow } from "../lib/catalog.js";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { LocaleQuery } from "../lib/i18n.js";
import type { AppEnv } from "../lib/types.js";
import { ProductSummarySchema } from "./catalog.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errors = { 401: json(ErrorSchema, "Not signed in") };
const security = [{ bearerAuth: [] }];
const Ok = z.object({ ok: z.literal(true) }).openapi("MeOk");
const iso = (v: unknown) => new Date(v as string | number | Date).toISOString();

const Profile = z.object({ id: z.string().uuid(), email: z.string(), name: z.string().nullable(), phone: z.string().nullable() }).openapi("MeProfile");
const FavoriteList = z.object({ ids: z.array(z.string().uuid()), products: z.array(ProductSummarySchema) }).openapi("FavoriteList");
const MyOrder = z
  .object({
    orderNumber: z.number().int(),
    /** Secret that opens the order page (`/orders/{orderNumber}?token=`). */
    token: z.string().uuid(),
    status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled", "returned"]),
    paymentMethod: z.enum(["cod", "chargily"]),
    paymentStatus: z.enum(["unpaid", "pending", "paid", "failed", "refunded"]),
    total: z.number().int(),
    itemCount: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("MyOrder");

export const meRoutes = new OpenAPIHono<AppEnv>();

async function profile(c: { get: (k: "db" | "userId" | "userEmail") => never }) {
  const db = c.get("db") as import("../lib/db.js").Db;
  const id = c.get("userId") as string;
  const r = (await db.query<{ full_name: string | null; phone: string | null }>(`select full_name, phone from public.customers where id = $1`, [id]))[0]!;
  return { id, email: c.get("userEmail") as string, name: r.full_name, phone: r.phone };
}

meRoutes.openapi(
  createRoute({ method: "get", path: "/me", tags: ["Account"], security, summary: "The signed-in customer's profile", responses: { 200: json(Profile, "OK"), ...errors } }),
  async (c) => c.json(await profile(c as never), 200),
);

meRoutes.openapi(
  createRoute({
    method: "put",
    path: "/me",
    tags: ["Account"],
    security,
    summary: "Update the profile (name, phone)",
    request: { body: body(z.object({ name: z.string().trim().min(2).max(80).nullable(), phone: z.string().trim().max(20).nullable() })) },
    responses: { 200: json(Profile, "Saved"), ...errors },
  }),
  async (c) => {
    const b = c.req.valid("json");
    await c.get("db").query(`update public.customers set full_name = $2, phone = $3 where id = $1`, [c.get("userId"), b.name, b.phone || null]);
    return c.json(await profile(c as never), 200);
  },
);

async function favorites(c: { get: (k: "db" | "userId") => never }, locale: "ar" | "fr" | "en") {
  const db = c.get("db") as import("../lib/db.js").Db;
  const rows = await db.query<SummaryRow>(
    `${SUMMARY_SQL} join public.favorites f on f.product_id = p.id and f.customer_id = $1 where p.is_published order by f.created_at desc, p.id`,
    [c.get("userId")],
  );
  return { ids: rows.map((r) => r.id), products: rows.map((r) => toSummary(r, locale)) };
}

meRoutes.openapi(
  createRoute({ method: "get", path: "/me/favorites", tags: ["Account"], security, summary: "Favorite products, newest first", request: { query: z.object({ locale: LocaleQuery }) }, responses: { 200: json(FavoriteList, "OK"), ...errors } }),
  async (c) => c.json(await favorites(c as never, c.req.valid("query").locale), 200),
);

meRoutes.openapi(
  createRoute({
    method: "post",
    path: "/me/favorites/merge",
    tags: ["Account"],
    security,
    summary: "Add many products to the favorites at once (used to copy the guest's favorites after sign-in)",
    request: { query: z.object({ locale: LocaleQuery }), body: body(z.object({ productIds: z.array(z.string().uuid()).max(200) })) },
    responses: { 200: json(FavoriteList, "OK"), ...errors },
  }),
  async (c) => {
    const { productIds } = c.req.valid("json");
    if (productIds.length) {
      await c.get("db").query(
        `insert into public.favorites (customer_id, product_id) select $1, p.id from public.products p where p.id = any($2::uuid[]) and p.is_published on conflict do nothing`,
        [c.get("userId"), productIds],
      );
    }
    return c.json(await favorites(c as never, c.req.valid("query").locale), 200);
  },
);

meRoutes.openapi(
  createRoute({
    method: "put",
    path: "/me/favorites/{productId}",
    tags: ["Account"],
    security,
    summary: "Add a product to the favorites",
    request: { params: z.object({ productId: z.string().uuid() }) },
    responses: { 200: json(Ok, "Added"), 404: json(ErrorSchema, "Unknown product"), ...errors },
  }),
  async (c) => {
    const { productId } = c.req.valid("param");
    const r = await c.get("db").query(
      `insert into public.favorites (customer_id, product_id) select $1, id from public.products where id = $2 and is_published on conflict do nothing returning product_id`,
      [c.get("userId"), productId],
    );
    if (!r.length && !(await c.get("db").query(`select 1 from public.favorites where customer_id = $1 and product_id = $2`, [c.get("userId"), productId])).length) {
      throw new ApiError(404, "not_found", "Product not found");
    }
    return c.json({ ok: true as const }, 200);
  },
);

meRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/me/favorites/{productId}",
    tags: ["Account"],
    security,
    summary: "Remove a product from the favorites",
    request: { params: z.object({ productId: z.string().uuid() }) },
    responses: { 200: json(Ok, "Removed"), ...errors },
  }),
  async (c) => {
    await c.get("db").query(`delete from public.favorites where customer_id = $1 and product_id = $2`, [c.get("userId"), c.req.valid("param").productId]);
    return c.json({ ok: true as const }, 200);
  },
);

meRoutes.openapi(
  createRoute({ method: "get", path: "/me/orders", tags: ["Account"], security, summary: "The customer's orders, newest first (never contains name, phone or address)", responses: { 200: json(z.array(MyOrder), "OK"), ...errors } }),
  async (c) => {
    const rows = await c.get("db").query<{ order_number: string; public_token: string; status: z.infer<typeof MyOrder>["status"]; payment_method: "cod" | "chargily"; payment_status: z.infer<typeof MyOrder>["paymentStatus"]; total: number; item_count: number; created_at: unknown }>(
      `select o.order_number, o.public_token, o.status, o.payment_method, o.payment_status, o.total, o.created_at,
              (select coalesce(sum(i.quantity), 0)::int from public.order_items i where i.order_id = o.id) as item_count
         from public.orders o where o.customer_id = $1 order by o.created_at desc limit 100`,
      [c.get("userId")],
    );
    return c.json(
      rows.map((r) => ({ orderNumber: Number(r.order_number), token: r.public_token, status: r.status, paymentMethod: r.payment_method, paymentStatus: r.payment_status, total: Number(r.total), itemCount: Number(r.item_count), createdAt: iso(r.created_at) })),
      200,
    );
  },
);
