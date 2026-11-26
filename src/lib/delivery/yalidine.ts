import { getEnv } from "../../env.js";
import { DeliveryError, type DeliveryProvider, type ParcelInput } from "./types.js";

type FetchLike = typeof fetch;

/**
 * Yalidine (https://yalidine.app). Keys: X-API-ID + X-API-TOKEN (Yalidine dashboard → Developers).
 * NOTE: written from Yalidine's public API documentation and covered by tests against a fake server;
 * check it once with real keys before launch (see docs/PROJECT_STATUS.md).
 */
export function yalidine(opts: { fetch?: FetchLike; apiId?: string; apiToken?: string; fromWilaya?: string; baseUrl?: string } = {}): DeliveryProvider {
  const http = opts.fetch ?? fetch;
  const cfg = () => {
    const env = getEnv();
    return { id: opts.apiId ?? env.YALIDINE_API_ID, token: opts.apiToken ?? env.YALIDINE_API_TOKEN, from: opts.fromWilaya ?? env.DELIVERY_FROM_WILAYA, base: opts.baseUrl ?? "https://api.yalidine.app/v1" };
  };

  async function call(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const { id, token, base } = cfg();
    if (!id || !token) throw new DeliveryError("Yalidine keys are not set");
    const res = await http(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { "X-API-ID": id, "X-API-TOKEN": token, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    // Never put the response body in the error: it can echo the customer's personal data.
    if (!res.ok) throw new DeliveryError(`Yalidine answered ${res.status}`, res.status >= 500 || res.status === 429);
    return data;
  }

  async function stopdeskId(communeName: string): Promise<number> {
    const r = (await call(`/centers/?commune_name=${encodeURIComponent(communeName)}&fields=center_id`)) as { data?: { center_id: number }[] };
    const id = r?.data?.[0]?.center_id;
    if (!id) throw new DeliveryError("No Yalidine desk in this commune");
    return id;
  }

  return {
    id: "yalidine",
    name: "Yalidine",
    configured: () => !!(cfg().id && cfg().token && cfg().from),
    async createParcel(i: ParcelInput) {
      const { from } = cfg();
      if (!from) throw new DeliveryError("DELIVERY_FROM_WILAYA is not set");
      const [first, ...rest] = i.customerName.trim().split(/\s+/);
      const parcel: Record<string, unknown> = {
        order_id: String(i.orderNumber),
        from_wilaya_name: from,
        firstname: first,
        familyname: rest.join(" ") || first,
        contact_phone: i.phone,
        address: i.address,
        to_commune_name: i.communeName,
        to_wilaya_name: i.wilayaName,
        product_list: i.productList,
        price: i.amountToCollect,
        do_insurance: false,
        declared_value: i.amountToCollect,
        height: 1, width: 1, length: 1, weight: 1,
        freeshipping: false,
        is_stopdesk: i.deliveryType === "desk",
        has_exchange: false,
      };
      if (i.deliveryType === "desk") parcel.stopdesk_id = await stopdeskId(i.communeName);
      const out = (await call("/parcels/", { method: "POST", body: [parcel] })) as Record<string, { success?: boolean; tracking?: string; message?: string }> | null;
      const r = out?.[String(i.orderNumber)];
      if (!r?.success || !r.tracking) throw new DeliveryError(`Yalidine refused the parcel${r?.message ? `: ${r.message}` : ""}`);
      return { trackingNumber: r.tracking, status: "created" };
    },
    async getTracking(tracking) {
      const r = (await call(`/parcels/${encodeURIComponent(tracking)}`)) as { data?: { last_status?: string }[] } | null;
      return { status: r?.data?.[0]?.last_status ?? "unknown" };
    },
    async cancelParcel(tracking) {
      await call(`/parcels/${encodeURIComponent(tracking)}`, { method: "DELETE" });
    },
  };
}
