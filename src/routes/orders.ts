import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ErrorSchema } from "../lib/errors.js";
import { LocaleQuery } from "../lib/i18n.js";
import { optionalUserId } from "../lib/auth.js";
import { computeQuote, createOrder } from "../lib/orders.js";
import type { AppEnv } from "../lib/types.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const errs = { 502: json(ErrorSchema, "Payment provider unavailable"), 409: json(ErrorSchema, "Out of stock"), 422: json(ErrorSchema, "Invalid order"), 429: json(ErrorSchema, "Too many orders") };

const ItemInput = z.object({ variantId: z.string().uuid(), quantity: z.number().int().min(1).max(10) });
const PricingInput = z.object({
  items: z.array(ItemInput).min(1).max(20),
  wilayaCode: z.number().int().min(1).max(58),
  deliveryType: z.enum(["home", "desk"]),
  /** Optional promo code (case-insensitive). */
  discountCode: z.string().trim().max(32).nullish(),
});

const QuoteSchema = z
  .object({
    items: z.array(z.object({ variantId: z.string().uuid(), productSlug: z.string(), name: z.string(), size: z.string(), color: z.string(), unitPrice: z.number().int(), quantity: z.number().int(), lineTotal: z.number().int() })),
    subtotal: z.number().int(),
    shippingFee: z.number().int(),
    freeShipping: z.boolean(),
    discountTotal: z.number().int(),
    discount: z.object({ code: z.string(), amount: z.number().int() }).nullable(),
    total: z.number().int(),
  })
  .openapi("OrderQuote");

const CreateOrderBody = PricingInput.extend({
  customer: z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().min(8).max(20),
    communeId: z.number().int(),
    address: z.string().trim().min(5).max(250),
  }),
  /** "cod" = cash on delivery; "chargily" = CIB / Edahabia card payment (only when `GET /payments/methods` says it is available). */
  paymentMethod: z.enum(["cod", "chargily"]).default("cod"),
  /** Language of the payment page and of the page the customer returns to. */
  locale: LocaleQuery.default("ar"),
}).openapi("CreateOrderBody");

const OrderCreated = z
  .object({
    orderNumber: z.number().int(),
    /** Secret needed to open the order page (GET /orders/{orderNumber}?token=). */
    token: z.string().uuid(),
    status: z.literal("pending"),
    paymentMethod: z.enum(["cod", "chargily"]),
    /** Card payments only: send the customer here to pay. */
    checkoutUrl: z.string().nullable(),
    subtotal: z.number().int(),
    shippingFee: z.number().int(),
    discountTotal: z.number().int(),
    total: z.number().int(),
  })
  .openapi("OrderCreated");

const OrderView = z
  .object({
    orderNumber: z.number().int(),
    status: z.enum(["pending", "confirmed", "shipped", "delivered", "cancelled", "returned"]),
    paymentMethod: z.enum(["cod", "chargily"]),
    paymentStatus: z.enum(["unpaid", "pending", "paid", "failed", "refunded"]),
    deliveryType: z.enum(["home", "desk"]),
    wilaya: z.string(),
    subtotal: z.number().int(),
    shippingFee: z.number().int(),
    discountTotal: z.number().int(),
    total: z.number().int(),
    trackingNumber: z.string().nullable(),
    createdAt: z.string(),
    items: z.array(z.object({ name: z.string(), size: z.string(), color: z.string(), unitPrice: z.number().int(), quantity: z.number().int(), lineTotal: z.number().int() })),
  })
  .openapi("OrderView");

export const orderRoutes = new OpenAPIHono<AppEnv>();

const toQuote = (q: Awaited<ReturnType<typeof computeQuote>>) => ({
  items: q.lines,
  subtotal: q.subtotal,
  shippingFee: q.shippingFee,
  freeShipping: q.freeShipping,
  discountTotal: q.discountTotal,
  discount: q.discount ? { code: q.discount.code, amount: q.discount.amount } : null,
  total: q.total,
});

orderRoutes.openapi(
  createRoute({
    method: "post",
    path: "/orders/quote",
    tags: ["Orders"],
    summary: "Price a cart on the server (items, shipping, promo code) without creating an order",
    request: { body: body(PricingInput) },
    responses: { 200: json(QuoteSchema, "OK"), ...errs },
  }),
  async (c) => c.json(toQuote(await computeQuote(c.get("db"), c.req.valid("json"))), 200),
);

orderRoutes.openapi(
  createRoute({
    method: "post",
    path: "/orders",
    tags: ["Orders"],
    summary: "Place an order (cash on delivery or card). Prices, shipping and stock are checked and applied by the server.",
    request: { body: body(CreateOrderBody) },
    responses: { 200: json(OrderCreated, "Order placed"), ...errs },
  }),
  async (c) => {
    const b = c.req.valid("json");
    const db = c.get("db");
    const pay = c.get("payment");
    if (b.paymentMethod === "chargily" && !pay.configured()) throw new ApiError(422, "payment_unavailable", "Card payment is not available right now");
    const customerId = await optionalUserId(c.req.header("authorization"), db);
    const r = await createOrder(db, { customerId, items: b.items, wilayaCode: b.wilayaCode, deliveryType: b.deliveryType, discountCode: b.discountCode, customer: b.customer, paymentMethod: b.paymentMethod });
    let checkoutUrl: string | null = null;
    if (b.paymentMethod === "chargily") {
      try {
        const co = await pay.createCheckout({ orderNumber: r.orderNumber, amount: r.quote.total, token: r.token, locale: b.locale });
        await db.query(`update public.orders set payment_ref = $2 where order_number = $1`, [r.orderNumber, co.ref]);
        checkoutUrl = co.checkoutUrl;
      } catch (e) {
        // The customer cannot pay: give the stock back and cancel the order so nothing stays reserved.
        console.error("Checkout creation failed:", (e as Error).name);
        await db.query(`select public.cancel_order((select id from public.orders where order_number = $1))`, [r.orderNumber]);
        throw new ApiError(502, "payment_failed", "Could not start the card payment. Please try again or choose cash on delivery.");
      }
    }
    return c.json(
      { orderNumber: r.orderNumber, token: r.token, status: "pending" as const, paymentMethod: b.paymentMethod, checkoutUrl, subtotal: r.quote.subtotal, shippingFee: r.quote.shippingFee, discountTotal: r.quote.discountTotal, total: r.quote.total },
      200,
    );
  },
);

orderRoutes.openapi(
  createRoute({
    method: "get",
    path: "/orders/{orderNumber}",
    tags: ["Orders"],
    summary: "A customer's own order (needs the secret token). Never contains name, phone or address.",
    request: { params: z.object({ orderNumber: z.coerce.number().int().positive() }), query: z.object({ token: z.string().uuid(), locale: LocaleQuery }) },
    responses: { 200: json(OrderView, "OK"), 404: json(ErrorSchema, "Not found") },
  }),
  async (c) => {
    const { orderNumber } = c.req.valid("param");
    const { token, locale } = c.req.valid("query");
    const db = c.get("db");
    const o = (
      await db.query<{ id: string; order_number: string; status: "pending"; payment_method: "cod"; payment_status: "unpaid"; delivery_type: "home"; name_ar: string; name_fr: string; subtotal: number; shipping_fee: number; discount_total: number; total: number; tracking_number: string | null; created_at: unknown }>(
        `select o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.delivery_type, w.name_ar, w.name_fr,
                o.subtotal, o.shipping_fee, o.discount_total, o.total, o.tracking_number, o.created_at
           from public.orders o join public.wilayas w on w.code = o.wilaya_code
          where o.order_number = $1 and o.public_token = $2`,
        [orderNumber, token],
      )
    )[0];
    if (!o) throw new ApiError(404, "not_found", "Order not found");
    const items = await db.query<{ product_name: string; size: string; color: string; unit_price: number; quantity: number; line_total: number }>(
      `select product_name, size, color, unit_price, quantity, line_total from public.order_items where order_id = $1 order by id`,
      [o.id],
    );
    return c.json(
      {
        orderNumber: Number(o.order_number), status: o.status, paymentMethod: o.payment_method, paymentStatus: o.payment_status, deliveryType: o.delivery_type,
        wilaya: locale === "ar" ? o.name_ar : o.name_fr, subtotal: Number(o.subtotal), shippingFee: Number(o.shipping_fee), discountTotal: Number(o.discount_total), total: Number(o.total),
        trackingNumber: o.tracking_number, createdAt: new Date(o.created_at as string).toISOString(),
        items: items.map((i) => ({ name: i.product_name, size: i.size, color: i.color, unitPrice: Number(i.unit_price), quantity: Number(i.quantity), lineTotal: Number(i.line_total) })),
      },
      200,
    );
  },
);
