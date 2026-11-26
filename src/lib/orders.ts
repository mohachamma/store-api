import type { Db, Query } from "./db.js";
import { ApiError } from "./errors.js";
import { pick } from "./i18n.js";

export interface OrderInput {
  items: { variantId: string; quantity: number }[];
  wilayaCode: number;
  deliveryType: "home" | "desk";
  discountCode?: string | null;
}

export interface QuoteLine {
  variantId: string;
  productSlug: string;
  name: string;
  size: string;
  color: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface Quote {
  lines: QuoteLine[];
  subtotal: number;
  shippingFee: number;
  freeShipping: boolean;
  discount: { id: string; code: string; amount: number } | null;
  discountTotal: number;
  total: number;
}

/** Normalises an Algerian phone number to the local format 0XXXXXXXXX. Returns null when it is not plausible. */
export function normalizePhone(raw: string): string | null {
  let p = raw.replace(/[\s.\-()]/g, "");
  if (p.startsWith("+213")) p = "0" + p.slice(4);
  else if (p.startsWith("00213")) p = "0" + p.slice(5);
  else if (p.startsWith("213") && p.length === 12) p = "0" + p.slice(3);
  return /^0[2-7]\d{7,8}$/.test(p) ? p : null;
}

/** International form for wa.me links: 0550123456 → 213550123456 */
export const toWhatsappNumber = (local: string) => "213" + local.replace(/^0/, "");

const fail = (status: 409 | 422, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};

async function getFreeShippingOver(q: Query): Promise<number | null> {
  const rows = await q.query<{ value: { free_shipping_over?: number | null } }>(`select value from public.site_settings where key = 'shipping_rules'`);
  const v = rows[0]?.value?.free_shipping_over;
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * Prices an order from the database ONLY (never from the client): unit prices, shipping fee, discount, totals.
 * Also checks that the products are published and that enough stock exists.
 */
export async function computeQuote(q: Query, input: OrderInput, opts: { forUpdate?: boolean } = {}): Promise<Quote> {
  // Merge duplicate variants.
  const wanted = new Map<string, number>();
  for (const it of input.items) wanted.set(it.variantId, (wanted.get(it.variantId) ?? 0) + it.quantity);
  if (wanted.size === 0 || wanted.size > 20) fail(422, "invalid_items", "The cart must contain between 1 and 20 different items");
  for (const n of wanted.values()) if (n > 10) fail(422, "invalid_items", "At most 10 units of the same item per order");

  const ids = [...wanted.keys()];
  const rows = await q.query<{ id: string; size: string; color: string; stock: number; price: number; slug: string; name: unknown }>(
    `select v.id, v.size, v.color, v.stock, v.price, p.slug, p.name
       from public.product_variants v join public.products p on p.id = v.product_id and p.is_published
      where v.id = any($1::uuid[]) ${opts.forUpdate ? "for update of v" : ""}`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: QuoteLine[] = [];
  for (const [variantId, quantity] of wanted) {
    const v = byId.get(variantId);
    if (!v) return fail(422, "item_unavailable", "One of the items is no longer available");
    if (Number(v.stock) < quantity) return fail(409, "out_of_stock", `Not enough stock for ${pick(v.name, "ar")} (${v.size})`);
    lines.push({ variantId, productSlug: v.slug, name: pick(v.name, "ar"), size: v.size, color: v.color, unitPrice: Number(v.price), quantity, lineTotal: Number(v.price) * quantity });
  }
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);

  const w = (await q.query<{ home_fee: number; desk_fee: number }>(`select home_fee, desk_fee from public.wilayas where code = $1 and active`, [input.wilayaCode]))[0];
  if (!w) return fail(422, "invalid_wilaya", "Delivery is not available to this wilaya");
  const baseFee = Number(input.deliveryType === "desk" ? w.desk_fee : w.home_fee);
  const freeOver = await getFreeShippingOver(q);
  const freeShipping = freeOver !== null && subtotal >= freeOver;
  const shippingFee = freeShipping ? 0 : baseFee;

  let discount: Quote["discount"] = null;
  const code = input.discountCode?.trim().toUpperCase();
  if (code) {
    const d = (
      await q.query<{ id: string; kind: "percent" | "fixed"; value: number; min_subtotal: number }>(
        `select id, kind, value, min_subtotal from public.discount_codes
          where code = $1 and is_active
            and (starts_at is null or starts_at <= now()) and (expires_at is null or expires_at > now())
            and (max_uses is null or used_count < max_uses)`,
        [code],
      )
    )[0];
    if (!d) return fail(422, "invalid_code", "This discount code is not valid");
    if (subtotal < Number(d.min_subtotal)) return fail(422, "code_min_subtotal", `This code needs a minimum order of ${d.min_subtotal} DA`);
    const amount = d.kind === "percent" ? Math.floor((subtotal * Number(d.value)) / 100) : Math.min(Number(d.value), subtotal);
    discount = { id: d.id, code, amount };
  }
  const discountTotal = discount?.amount ?? 0;
  return { lines, subtotal, shippingFee, freeShipping, discount, discountTotal, total: subtotal + shippingFee - discountTotal };
}

export interface CustomerInput {
  name: string;
  phone: string;
  communeId: number;
  address: string;
}

/** Creates a pending cash-on-delivery order atomically: stock is reserved, the discount counted, an admin event emitted. */
export async function createOrder(db: Db, input: OrderInput & { customer: CustomerInput; paymentMethod: "cod" | "chargily"; customerId?: string | null }) {
  const phone = normalizePhone(input.customer.phone);
  if (!phone) throw new ApiError(422, "invalid_phone", "Enter a valid Algerian phone number");

  return db.tx(async (q) => {
    // Throttle spam: at most 3 pending orders per phone number per hour.
    const recent = await q.query<{ n: number }>(
      `select count(*)::int as n from public.orders where status = 'pending' and customer_phone = $1 and created_at > now() - interval '1 hour'`,
      [phone],
    );
    if (Number(recent[0]?.n ?? 0) >= 3) throw new ApiError(429, "rate_limited", "Too many orders from this phone number. Please try again later.");

    const communeOk = await q.query(`select 1 from public.communes where id = $1 and wilaya_code = $2`, [input.customer.communeId, input.wilayaCode]);
    if (!communeOk.length) throw new ApiError(422, "invalid_commune", "This commune does not belong to the selected wilaya");

    const quote = await computeQuote(q, input, { forUpdate: true });

    for (const l of quote.lines) {
      const upd = await q.query(`update public.product_variants set stock = stock - $2 where id = $1 and stock >= $2 returning id`, [l.variantId, l.quantity]);
      if (!upd.length) throw new ApiError(409, "out_of_stock", `Not enough stock for ${l.name} (${l.size})`);
    }
    if (quote.discount) {
      const used = await q.query(
        `update public.discount_codes set used_count = used_count + 1 where id = $1 and (max_uses is null or used_count < max_uses) returning id`,
        [quote.discount.id],
      );
      if (!used.length) throw new ApiError(422, "invalid_code", "This discount code is no longer available");
    }

    const order = (
      await q.query<{ id: string; order_number: string; public_token: string }>(
        `insert into public.orders (customer_id, payment_method, payment_status, delivery_type, wilaya_code, discount_code_id, subtotal, shipping_fee, discount_total, total,
                                    customer_name, customer_phone, commune_id, address)
         values ($14, $1, $13, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id, order_number, public_token`,
        [input.paymentMethod, input.deliveryType, input.wilayaCode, quote.discount?.id ?? null, quote.subtotal, quote.shippingFee, quote.discountTotal, quote.total,
         input.customer.name.trim(), phone, input.customer.communeId, input.customer.address.trim(), input.paymentMethod === "chargily" ? "pending" : "unpaid", input.customerId ?? null],
      )
    )[0]!;
    for (const l of quote.lines) {
      await q.query(
        `insert into public.order_items (order_id, variant_id, product_name, size, color, unit_price, quantity) values ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, l.variantId, l.name, l.size, l.color, l.unitPrice, l.quantity],
      );
    }
    return { orderNumber: Number(order.order_number), token: order.public_token, quote };
  });
}
