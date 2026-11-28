import type { Query } from "./db.js";
import type { Locale } from "./i18n.js";
import { toWhatsappNumber } from "./orders.js";

export const MESSAGE_KEYS = ["ask", "confirm", "tracking"] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];
export type Messages = Record<MessageKey, Record<Locale, string>>;

/**
 * Texts of the three WhatsApp messages (editable from the dashboard).
 * Placeholders: {name} {number} {total} {tracking} {link} (our order page) {carrierLink} (the delivery company's tracking page, when saved)
 *  - ask:      the store writes to the customer to ask him to confirm the order
 *  - confirm:  the customer writes to the store to confirm (button on the order page)
 *  - tracking: the store sends the tracking number and link after approving the order
 */
export const DEFAULT_MESSAGES: Messages = {
  ask: {
    ar: "مرحباً {name} 👋\nاستلمنا طلبك رقم #{number} بقيمة {total}.\nهل تؤكد الطلب؟ أجبنا بـ «نعم» ليتم شحنه إليك.",
    fr: "Bonjour {name} 👋\nNous avons bien reçu votre commande n°{number} d'un montant de {total}.\nConfirmez-vous la commande ? Répondez « oui » pour que nous l'expédiions.",
    en: "Hello {name} 👋\nWe received your order #{number} for {total}.\nDo you confirm it? Reply \"yes\" and we will ship it.",
  },
  confirm: {
    ar: "مرحباً، أؤكد طلبي رقم #{number} ✅",
    fr: "Bonjour, je confirme ma commande n°{number} ✅",
    en: "Hello, I confirm my order #{number} ✅",
  },
  tracking: {
    ar: "تم تأكيد طلبك رقم #{number} ✅\nرقم التتبع: {tracking}\nتابع طلبك من هنا: {link}",
    fr: "Votre commande n°{number} est confirmée ✅\nNuméro de suivi : {tracking}\nSuivez-la ici : {link}",
    en: "Your order #{number} is confirmed ✅\nTracking number: {tracking}\nFollow it here: {link}",
  },
};

export async function loadMessages(q: Query): Promise<Messages> {
  const rows = await q.query<{ value: Partial<Record<MessageKey, Partial<Record<Locale, string>>>> }>(`select value from public.site_settings where key = 'whatsapp_messages'`);
  const v = rows[0]?.value ?? {};
  const out = {} as Messages;
  for (const k of MESSAGE_KEYS) {
    out[k] = { ar: v[k]?.ar?.trim() || DEFAULT_MESSAGES[k].ar, fr: v[k]?.fr?.trim() || DEFAULT_MESSAGES[k].fr, en: v[k]?.en?.trim() || DEFAULT_MESSAGES[k].en };
  }
  return out;
}

export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

/** wa.me link opening a chat with a number (Algerian local format like 0550123456) with the text already typed. */
export function waLink(localPhone: string, text: string): string {
  return `https://wa.me/${toWhatsappNumber(localPhone)}?text=${encodeURIComponent(text)}`;
}

/** Page where the customer follows his order (no personal data on it). */
export function orderPageUrl(origin: string | undefined, locale: string, orderNumber: number, token: string): string {
  return `${(origin ?? "").replace(/\/$/, "")}/${locale}/order/${orderNumber}?t=${token}`;
}
