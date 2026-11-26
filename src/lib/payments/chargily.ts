import { ChargilyClient, verifySignature } from "@chargily/chargily-pay";
import { getEnv } from "../../env.js";
import { ApiError } from "../errors.js";
import type { PaymentProvider } from "./types.js";

/** Chargily Pay v2 (CIB / Edahabia). Test keys first, live keys at launch (CHARGILY_MODE). */
export function chargily(): PaymentProvider {
  const client = () => {
    const env = getEnv();
    return new ChargilyClient({ api_key: env.CHARGILY_SECRET_KEY!, mode: env.CHARGILY_MODE });
  };
  return {
    id: "chargily",
    configured: () => !!getEnv().CHARGILY_SECRET_KEY && !!getEnv().PUBLIC_API_URL,
    async createCheckout(i) {
      const env = getEnv();
      const web = env.WEB_ORIGIN[0];
      if (!web) throw new Error("WEB_ORIGIN is not set");
      const order = `${web}/${i.locale}/order/${i.orderNumber}?t=${i.token}`;
      const c = await client().createCheckout({
        amount: i.amount,
        currency: "dzd",
        success_url: order,
        failure_url: order,
        webhook_endpoint: `${env.PUBLIC_API_URL}/webhooks/chargily`,
        description: `Order #${i.orderNumber}`,
        locale: i.locale,
        metadata: { orderNumber: i.orderNumber },
      });
      return { ref: c.id, checkoutUrl: c.checkout_url };
    },
    parseWebhook(raw, signature) {
      const secret = getEnv().CHARGILY_SECRET_KEY;
      let valid: boolean;
      try {
        // The package throws on a mismatch (and on malformed signatures); treat both as "invalid".
        valid = !!secret && !!signature && verifySignature(Buffer.from(raw), signature, secret);
      } catch {
        valid = false;
      }
      if (!valid) throw new ApiError(401, "bad_signature", "Invalid webhook signature");
      const event = JSON.parse(raw) as { type?: string; data?: { id?: string } };
      const ref = event.data?.id;
      if (!ref) return null;
      if (event.type === "checkout.paid") return { ref, status: "paid" };
      if (event.type === "checkout.failed" || event.type === "checkout.canceled" || event.type === "checkout.expired") return { ref, status: "failed" };
      return null;
    },
  };
}
