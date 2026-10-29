import type { NotificationItem } from "./api";

/**
 * Where "Give credit" goes from a Player's "Top-up requested" alert: their page with the Credit form open, the
 * amount they asked for filled in. Alerts from before the request carried its own link are known by their title
 * and the account they name.
 */
export function topUpCreditLink(item: NotificationItem): string | null {
  const meta = (item.metadata ?? null) as { topUpRequest?: unknown; deepLink?: unknown; accountId?: unknown; amount?: unknown } | null;
  if (!meta) return null;
  if (meta.topUpRequest === true && typeof meta.deepLink === "string") return meta.deepLink;
  if (item.title !== "Top-up requested" || typeof meta.accountId !== "string") return null;
  const amount = typeof meta.amount === "number" && meta.amount > 0 ? `&amount=${meta.amount}` : "";
  return `/dashboard/people/${encodeURIComponent(meta.accountId)}?credit=1${amount}`;
}
