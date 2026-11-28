import type { Query } from "../db.js";
import { yalidine } from "./yalidine.js";
import type { DeliveryProvider } from "./types.js";

export * from "./types.js";

/** "manual": no company integration; the admin types the tracking number himself. */
export const manualProvider: DeliveryProvider = {
  id: "manual",
  name: "Manual",
  configured: () => true,
  async createParcel() { throw new Error("manual provider has no API"); },
  async getTracking() { return { status: "unknown" }; },
  async cancelParcel() { /* nothing to cancel */ },
};

/** Every delivery company the store can use. Add new adapters here; the admin picks one from the dashboard. */
export function buildProviders(): Record<string, DeliveryProvider> {
  const y = yalidine();
  return { manual: manualProvider, [y.id]: y };
}

/**
 * Link to the delivery company's own tracking page for a parcel (the owner pastes it in the dashboard, with {tracking} where the code goes).
 * Uses the company's own entry, else the one saved for "manual". Null when none is set.
 */
export async function carrierTrackingUrl(q: Query, company: string | null, tracking: string | null): Promise<string | null> {
  if (!tracking) return null;
  const r = await q.query<{ value: { tracking_urls?: Record<string, string> } }>(`select value from public.site_settings where key = 'delivery'`);
  const urls = r[0]?.value?.tracking_urls ?? {};
  const tpl = (company && urls[company.toLowerCase()]) || urls["manual"];
  return tpl ? tpl.replace("{tracking}", encodeURIComponent(tracking)) : null;
}

export async function getActiveProviderId(q: Query): Promise<string> {
  const r = await q.query<{ value: { provider?: string } }>(`select value from public.site_settings where key = 'delivery'`);
  return r[0]?.value?.provider ?? "manual";
}
