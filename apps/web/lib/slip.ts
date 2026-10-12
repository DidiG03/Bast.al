/** One pick on the bet slip, kept in this browser for the signed-in account. */
export type SlipItem = {
  selectionId: string;
  eventId: string;
  eventName: string;
  startsAt: string;
  market: string;
  name: string;
  odds: number;
  /** The price when it was added, if the price has moved since. */
  previousOdds?: number;
  stake: string;
  closed?: boolean;
  /** A live pick whose market is suspended or whose prices went stale for now. */
  paused?: boolean;
  live?: boolean;
  /** Greyhounds: paid at the starting price (or forecast dividend); `odds` is 0. Singles only. */
  sp?: boolean;
};

export const MAX_SLIP = 10;

/** Each account's slip is kept apart, so a Player on a shared phone never sees another one's picks. */
const slipStorage = (userId: string) => `bastal-bet-slip:${userId}`;

export function readSlip(userId: string): SlipItem[] {
  try {
    // The slip used to be kept for whoever signed in last on this browser.
    window.localStorage.removeItem("bastal-bet-slip");
    const raw = window.localStorage.getItem(slipStorage(userId));
    const parsed = raw ? (JSON.parse(raw) as SlipItem[]) : [];
    // Live picks stay on the slip for the length of a match; the next odds refresh closes any that ended.
    return Array.isArray(parsed) ? parsed.filter((item) => new Date(item.startsAt).getTime() > Date.now() - 3 * 3_600_000).slice(0, MAX_SLIP) : [];
  } catch {
    return [];
  }
}

export function saveSlip(userId: string, items: SlipItem[]) {
  try {
    window.localStorage.setItem(slipStorage(userId), JSON.stringify(items));
  } catch {
    // The slip still works for this visit.
  }
}

/** Adds a pick from outside the bet page (the home cards). The last stake is kept, the same way the board does. */
export function addToSlip(userId: string, item: Omit<SlipItem, "stake">): "added" | "exists" | "full" {
  const items = readSlip(userId);
  if (items.some((current) => current.selectionId === item.selectionId)) return "exists";
  if (items.length >= MAX_SLIP) return "full";
  saveSlip(userId, [...items, { ...item, stake: items[items.length - 1]?.stake ?? "" }]);
  return "added";
}
