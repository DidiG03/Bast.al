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
  /** Why it's paused and when it's back, if known (SelectionQuote.pause). */
  pause?: { reason: string; until: string | null } | null;
  /** The feed no longer offers this line; this one, the same side of the line it offers now, can take its place. */
  replacement?: { id: string; market: string; name: string; price: number } | null;
  live?: boolean;
  /** Greyhounds: paid at the starting price (or forecast dividend); `odds` is 0. Singles only. */
  sp?: boolean;
  /** When it was put on the slip (ms): a pick removed after that stays off (see removedPicks). */
  addedAt?: number;
};

export const MAX_SLIP = 10;

/** Each account's slip is kept apart, so a Player on a shared phone never sees another one's picks. */
const slipStorage = (userId: string) => `bastal-bet-slip:${userId}`;
/** The picks taken off the slip, and when (ms), kept for REMOVED_KEPT_MS. */
const removedStorage = (userId: string) => `bastal-bet-slip-removed:${userId}`;
const REMOVED_KEPT_MS = 24 * 3_600_000;

/** The storage key a tab listens to for another tab's changes to this account's slip. */
export const slipStorageKey = slipStorage;

/**
 * Picks taken off the slip in the last day, and when. Another tab, or an
 * older copy of the slip, may still hold one and save it back: a pick removed
 * after it was added stays off, so removing is for good. Adding it again
 * later puts it back (its `addedAt` is newer).
 */
function removedPicks(userId: string): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(removedStorage(userId));
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Notes picks as taken off the slip now (see removedPicks). */
export function forgetPicks(userId: string, ids: string[]) {
  if (ids.length === 0) return;
  try {
    const now = Date.now();
    const kept = Object.entries(removedPicks(userId)).filter(([, at]) => now - at < REMOVED_KEPT_MS);
    const next = Object.fromEntries([...kept, ...ids.map((id) => [id, now] as const)]);
    window.localStorage.setItem(removedStorage(userId), JSON.stringify(next));
  } catch {
    // Removing still works for this visit.
  }
}

/** Whether a pick was taken off the slip after it was put on (see removedPicks). */
function wasRemoved(item: SlipItem, removed: Record<string, number>): boolean {
  const at = removed[item.selectionId];
  return at !== undefined && at >= (item.addedAt ?? 0);
}

export function readSlip(userId: string): SlipItem[] {
  try {
    // The slip used to be kept for whoever signed in last on this browser.
    window.localStorage.removeItem("bastal-bet-slip");
    const raw = window.localStorage.getItem(slipStorage(userId));
    const parsed = raw ? (JSON.parse(raw) as SlipItem[]) : [];
    const removed = removedPicks(userId);
    // Live picks stay on the slip for the length of a match; the next odds refresh drops any that ended.
    return Array.isArray(parsed)
      ? parsed.filter((item) => new Date(item.startsAt).getTime() > Date.now() - 3 * 3_600_000 && !wasRemoved(item, removed)).slice(0, MAX_SLIP)
      : [];
  } catch {
    return [];
  }
}

/** Saves the slip, leaving out any pick removed meanwhile (in this tab or another): those stay off. */
export function saveSlip(userId: string, items: SlipItem[]) {
  try {
    const removed = removedPicks(userId);
    const next = JSON.stringify(items.filter((item) => !wasRemoved(item, removed)));
    // Unchanged: not written again, so other tabs aren't told about nothing.
    if (window.localStorage.getItem(slipStorage(userId)) !== next) window.localStorage.setItem(slipStorage(userId), next);
  } catch {
    // The slip still works for this visit.
  }
}

/** Adds a pick from outside the bet page (the home cards). The last stake is kept, the same way the board does. */
export function addToSlip(userId: string, item: Omit<SlipItem, "stake">): "added" | "exists" | "full" {
  const items = readSlip(userId);
  if (items.some((current) => current.selectionId === item.selectionId)) return "exists";
  if (items.length >= MAX_SLIP) return "full";
  saveSlip(userId, [...items, { ...item, stake: items[items.length - 1]?.stake ?? "", addedAt: Date.now() }]);
  return "added";
}
