"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BetLegs } from "../../../components/bet-legs";
import { LineFamily, MarketHead, bundleLines, marketKind, resultHeads, visibleCountry } from "../../../components/line-market";
import { MatchCentre, MatchStatsPanel } from "../../../components/match-centre";
import { GreyhoundRaces } from "../../../components/greyhound-races";
import { ListSkeleton, LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { MarketPriceHistory } from "../../../components/price-history";
import { useRealtime } from "../../../components/realtime-provider";
import { SportIcon } from "../../../components/sport-icon";
import { TeamCrest } from "../../../components/team-crest";
import { ApiError, apiFetch, type Bet, type BuilderQuote, type LiveWait, type MarketPause, type MyBets, type OddsEvent, type OddsSelection, type OddsSettings, type PlaceBetsResponse, type SelectionQuote, type SlipInfo, type Sport } from "../../../lib/api";
import { formatMoney, formatStake } from "../../../lib/format";
import { byImportance } from "../../../lib/importance";
import { MAX_SLIP, forgetPicks, readSlip, saveSlip, slipStorageKey, type SlipItem } from "../../../lib/slip";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";
import { showBalance, showPending } from "../../../components/balance-chip";
import { useTopUpRequest } from "../../../components/top-up-request";
import { breakPause, liveClock } from "../../../lib/live";
import { applyDelta, applyToList, applyToSlip, byMatch, hasUnknownSelections } from "../../../lib/live-push";
import { usePolling } from "../../../lib/use-polling";
import { pickLabel } from "../../../lib/picks";
import { serverNow } from "../../../lib/clock";
import { addDays, dayKey } from "../../../lib/time";
import { MIN_SYSTEM_LINE_STAKE, systemBreakdown, systemLineCount, systemMaxReturn, systemOptions, type SystemOption } from "../../../lib/system-bets";

type Tab = "matches" | "open" | "settled";
/** "accumulator" combines the picks: an accumulator, or a bet builder when they're all from one match. "system" makes every double, treble… of them. */
type SlipMode = "singles" | "accumulator" | "system";

/** How long a price shows its up or down arrow after it moves. */
const MOVE_SHOWN_MS = 15_000;
/** A match's markets fetched ahead of opening it are shown as they are for this long; older, they're fetched again as it opens. */
const DETAIL_FRESH_MS = 10_000;

type PriceMove = { up: boolean; until: number };
/** How long a live slip's checks with the feed usually take after its wait (the API allows more, rarely needed). */
const CHECK_TYPICAL_MS = 1_000;
/** One tap fills the stake on the ticket, in ALL. */
const QUICK_STAKES = [10, 50, 100, 500, 1000];
/** Matches the API's cap on an accumulator's combined odds. */
const MAX_ACCUMULATOR_ODDS = 5000;
/** Matches drawn at first; "Show more matches" adds this many again, so a week of football doesn't slow a phone down. */
const MATCHES_SHOWN = 60;

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const DATE_TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

/**
 * Each match's day heading (Today, Tomorrow, then the day's name), for a
 * whole list at once: today's and tomorrow's dates are worked out once, not
 * again for every match, and each day's name is spelled out once.
 */
function dayLabeller({ t, date: format }: I18n): (iso: string) => string {
  const today = dayKey(Date.now());
  const tomorrow = dayKey(addDays(new Date(), 1));
  const byDay = new Map<string, string>();
  return (iso) => {
    const key = dayKey(iso);
    if (key === today) return t("Today");
    if (key === tomorrow) return t("Tomorrow");
    let label = byDay.get(key);
    if (label === undefined) {
      // Albanian day names are lower case ("e premte"); as a heading it starts with a capital.
      const name = format(new Date(iso), { weekday: "long", day: "numeric", month: "short" });
      label = name.charAt(0).toUpperCase() + name.slice(1);
      byDay.set(key, label);
    }
    return label;
  };
}

/**
 * The system the slip is set to, or null when its picks can't make one (fewer
 * than 3 or more than 8, two from one match, a race pick). Without a choice
 * yet, the named one that covers every size (a Trixie, a Yankee…).
 */
function chosenSystem(items: SlipItem[], key: string): SystemOption | null {
  if (new Set(items.map((item) => item.eventId)).size !== items.length || items.some((item) => item.sp)) return null;
  const options = systemOptions(items.length);
  return options.find((option) => option.sizes.join(",") === key) ?? options.find((option) => option.name) ?? options[0] ?? null;
}

/** Stake x odds, rounded down to the cent like the server does. */
function returns(stake: number, odds: number): number {
  return Math.floor(stake * odds * 100 + 1e-6) / 100;
}

/** The product of the prices, rounded down to 2 decimals like the server does. Exact, in cents. */
function combinedOdds(odds: number[]): number {
  if (odds.length === 0) return 0;
  let product = BigInt(1);
  let scale = BigInt(1);
  for (const price of odds) {
    product *= BigInt(Math.round(price * 100));
    scale *= BigInt(100);
  }
  scale /= BigInt(100);
  return Number(product / scale) / 100;
}

function stakeValue(stake: string): number {
  const value = Number(stake);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
}

export default function BetPageRoute() {
  return (
    <Suspense fallback={<PageLoading label="Loading" />}>
      <BetPage />
    </Suspense>
  );
}

function BetPage() {
  const { getToken, userId } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts } = i18n;
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "open" || tabParam === "settled" ? tabParam : "matches";
  const sportParam = params.get("sport");
  const sport: Sport = (["greyhounds", "mma", "basketball", "nfl", "tennis", "volleyball", "handball"] as const).find((name) => name === sportParam) ?? "football";
  /** Football and MMA share the match list; greyhound races have their own. */
  const listed = sport !== "greyhounds";
  // Opened from a match on the Overview: scroll to it and light it up.
  const matchParam = params.get("match");
  const [focused, setFocused] = useState<string | null>(null);
  // Greyhound racing only shows once its feed is connected: until then there are no races to bet on.
  const [greyhoundsOn, setGreyhoundsOn] = useState(false);
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      setGreyhoundsOn(Boolean((await apiFetch<OddsSettings>("/odds/settings", token)).greyhoundsFeed));
    })().catch(() => undefined);
  }, [getToken]);

  const [events, setEvents] = useState<OddsEvent[] | null>(null);
  const [info, setInfo] = useState<SlipInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const [slip, setSlip] = useState<SlipItem[]>([]);
  const [slipLoaded, setSlipLoaded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pathname = usePathname();
  const routeKey = `${pathname}?${params.toString()}`;
  const routeSeen = useRef(routeKey);
  function closeSheet() {
    setSheetOpen(false);
  }
  useEffect(() => {
    if (routeSeen.current === routeKey) return;
    routeSeen.current = routeKey;
    setSheetOpen(false);
  }, [routeKey]);
  useEffect(() => {
    if (!sheetOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [sheetOpen]);
  const [mode, setMode] = useState<SlipMode>("singles");
  const [accaStake, setAccaStake] = useState("");
  /** The system's line sizes, as "2,3,4". */
  const [systemKey, setSystemKey] = useState("");
  const [league, setLeague] = useState("");
  const [search, setSearch] = useState("");
  /** "" = every day, "live" = playing now, otherwise a day's label (Today, Tomorrow, …). */
  const [day, setDay] = useState("");
  /** The matches this account starred, and whether only those are showing. */
  const [favourites, setFavourites] = useState<Set<string>>(new Set());
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const favouritesRef = useRef(favourites);
  favouritesRef.current = favourites;
  /** The kinds of market this account starred (marketKind): first, under Favourites, on every match that has them. */
  const [favouriteMarkets, setFavouriteMarkets] = useState<Set<string>>(new Set());
  const favouriteMarketsRef = useRef(favouriteMarkets);
  favouriteMarketsRef.current = favouriteMarkets;
  const [betsVersion, setBetsVersion] = useState(0);
  const [limit, setLimit] = useState(MATCHES_SHOWN);
  /** Matches opened to show every market, and those markets once loaded. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, OddsEvent>>({});
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const slipRef = useRef<SlipItem[]>([]);

  // The list carries each match's main market only; the rest load when a match is opened.
  // `only: "live"` asks for the live matches again and keeps the rest as they are.
  const lists = useRef<{ live: OddsEvent[] | null; upcoming: OddsEvent[] | null }>({ live: null, upcoming: null });
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const loadEvents = useCallback(
    async (only?: "live") => {
      const token = await getToken();
      if (!token) return;
      const list = (filter: "live" | "upcoming") => apiFetch<OddsEvent[]>(`/odds/events?filter=${filter}&view=list&sport=${sport}`, token, { revalidate: true });
      // Only football is bet on once it starts: the other sports have no live list.
      const livePromise = sport !== "football" ? Promise.resolve([] as OddsEvent[]) : list("live");
      // The first time, the live matches show as soon as they come, before the (longer) list of the days ahead.
      if (lists.current.live === null && lists.current.upcoming === null && sport === "football") {
        void livePromise
          .then((live) => {
            if (sportRef.current === sport && lists.current.upcoming === null && live.length > 0) setEvents((current) => current ?? live);
          })
          .catch(() => undefined);
      }
      const [fetchedLive, upcoming] = await Promise.all([livePromise, only === "live" && lists.current.upcoming ? lists.current.upcoming : list("upcoming")]);
      // A list that was already loading can come back without a pause the push just showed. The pause stays until it ends.
      const previous = new Map((lists.current.live ?? []).map((event) => [event.id, event]));
      const live = fetchedLive.map((event) => {
        const old = previous.get(event.id);
        if (event.marketPause || !old?.marketPause || Date.parse(old.marketPause.until) <= Date.now()) return event;
        return { ...event, marketPause: old.marketPause };
      });
      // Nothing changed (the API said so), or the Player switched sport meanwhile: the page keeps what it has.
      if ((live === lists.current.live && upcoming === lists.current.upcoming) || sportRef.current !== sport) return;
      lists.current = { live, upcoming };
      setEvents([...live, ...upcoming]);
    },
    [getToken, sport],
  );

  // Another sport: its own list, from scratch.
  useEffect(() => {
    lists.current = { live: null, upcoming: null };
    setEvents(null);
    setLeague("");
    setDay("");
  }, [sport]);

  /** When each match's markets were last fetched, and the fetches under way (several asks share one). */
  const detailAt = useRef(new Map<string, number>());
  const detailLoads = useRef(new Map<string, Promise<void>>());
  const loadDetail = useCallback(
    (id: string) => {
      const running = detailLoads.current.get(id);
      if (running) return running;
      const load = (async () => {
        const token = await getToken();
        if (!token) return;
        const full = await apiFetch<OddsEvent>(`/odds/events/${id}`, token, { revalidate: true });
        detailAt.current.set(id, Date.now());
        setDetails((current) => (current[id] === full ? current : { ...current, [id]: full }));
      })().finally(() => detailLoads.current.delete(id));
      detailLoads.current.set(id, load);
      return load;
    },
    [getToken],
  );

  // The slip's picks are priced on their own, so a pick on a market that isn't loaded still moves and closes.
  const refreshSlip = useCallback(async () => {
    const ids = slipRef.current.map((item) => item.selectionId);
    if (ids.length === 0) return;
    const token = await getToken();
    if (!token) return;
    const quotes = await apiFetch<SelectionQuote[]>(`/odds/selections?ids=${ids.map(encodeURIComponent).join(",")}`, token);
    const byId = new Map(quotes.map((quote) => [quote.id, quote]));
    // Picks that are over for good (the match finished, the market settled, the pick withdrawn, or gone): off the slip.
    const gone = slipRef.current.filter((item) => ids.includes(item.selectionId) && (!byId.has(item.selectionId) || byId.get(item.selectionId)!.final));
    if (gone.length > 0) {
      toast.info(
        gone.length === 1
          ? t("{pick} was taken off your slip: that market has closed for good.", { pick: `${gone[0].name} (${gone[0].eventName})` })
          : t("{count} picks were taken off your slip: their markets have closed for good.", { count: gone.length }),
      );
    }
    const goneIds = new Set(gone.map((item) => item.selectionId));
    setSlip((items) =>
      items.filter((item) => !goneIds.has(item.selectionId)).map((item) => {
        const quote = byId.get(item.selectionId);
        if (!quote || !quote.open) return { ...item, closed: true, paused: false };
        const paused = !quote.bettable;
        // A race pick has no price to follow; it closes a minute before the start.
        if (quote.sp) return { ...item, closed: !quote.bettable, paused: false, sp: true };
        if (quote.price === item.odds) return { ...item, closed: false, paused, live: quote.live };
        const previous = item.previousOdds ?? item.odds;
        return { ...item, closed: false, paused, live: quote.live, odds: quote.price, previousOdds: previous === quote.price ? undefined : previous };
      }),
    );
  }, [getToken, toast, t]);

  /** Everything on the page again: the list (or only its live matches), every opened match, and the slip's prices. */
  const refreshAll = useCallback(
    async (only?: "live") => {
      await Promise.all([loadEvents(only), ...Array.from(expandedRef.current, (id) => loadDetail(id).catch(() => undefined)), refreshSlip().catch(() => undefined)]);
    },
    [loadEvents, loadDetail, refreshSlip],
  );

  // Read through refs, so the match cards keep the same handler and don't redraw on every keystroke in the slip.
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const toggleExpanded = useCallback(
    (id: string) => {
      const opening = !expandedRef.current.has(id);
      setExpanded((current) => {
        const next = new Set(current);
        if (opening) next.add(id);
        else next.delete(id);
        return next;
      });
      if (!opening) return;
      if (!detailsRef.current[id]) void loadDetail(id).catch(() => toast.error(t("Couldn't load the matches")));
      // Fetched ahead (see prefetchDetail) a while ago: shown at once, and fetched again behind it.
      else if (Date.now() - (detailAt.current.get(id) ?? 0) > DETAIL_FRESH_MS) void loadDetail(id).catch(() => undefined);
    },
    [loadDetail, toast, t],
  );

  /**
   * A finger or pointer on a match's "more markets" button: its markets start
   * loading now, so they're there when it opens.
   */
  const prefetchDetail = useCallback(
    (id: string) => {
      if (detailsRef.current[id] && Date.now() - (detailAt.current.get(id) ?? 0) <= DETAIL_FRESH_MS) return;
      void loadDetail(id).catch(() => undefined);
    },
    [loadDetail],
  );

  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const [matches, markets] = await Promise.all([apiFetch<string[]>("/odds/favourites", token), apiFetch<string[]>("/odds/favourite-markets", token)]);
      setFavourites(new Set(matches));
      setFavouriteMarkets(new Set(markets));
    })().catch(() => undefined);
  }, [getToken]);

  // The star changes at once; if saving it fails, it goes back and says why.
  const toggleFavourite = useCallback(
    async (id: string) => {
      const starring = !favouritesRef.current.has(id);
      const flip = (on: boolean) =>
        setFavourites((current) => {
          const next = new Set(current);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        });
      flip(starring);
      try {
        const token = await getToken();
        if (!token) throw new Error(t("Couldn't save your favourites"));
        await apiFetch<string[]>(`/odds/favourites/${encodeURIComponent(id)}`, token, { method: starring ? "PUT" : "DELETE" });
      } catch (err) {
        flip(!starring);
        toast.error(err instanceof Error ? err.message : t("Couldn't save your favourites"));
      }
    },
    [getToken, toast, t],
  );

  // A market's star, the same way: at once, and back if saving fails.
  const toggleFavouriteMarket = useCallback(
    async (kind: string) => {
      const starring = !favouriteMarketsRef.current.has(kind);
      const flip = (on: boolean) =>
        setFavouriteMarkets((current) => {
          const next = new Set(current);
          if (on) next.add(kind);
          else next.delete(kind);
          return next;
        });
      flip(starring);
      try {
        const token = await getToken();
        if (!token) throw new Error(t("Couldn't save your favourites"));
        await apiFetch<string[]>(`/odds/favourite-markets/${encodeURIComponent(kind)}`, token, { method: starring ? "PUT" : "DELETE" });
      } catch (err) {
        flip(!starring);
        toast.error(err instanceof Error ? err.message : t("Couldn't save your favourites"));
      }
    },
    [getToken, toast, t],
  );

  const loadInfo = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setInfo(await apiFetch<SlipInfo>("/bets/slip", token));
  }, [getToken]);

  useEffect(() => {
    if (!userId) return;
    setSlip(readSlip(userId));
    setSlipLoaded(true);
  }, [userId]);

  useEffect(() => {
    if (slipLoaded && userId) {
      // Picks taken off (removed, cleared, placed, or dropped as over) stay off, even if another tab still holds them.
      const kept = new Set(slip.map((item) => item.selectionId));
      forgetPicks(userId, slipRef.current.filter((item) => !kept.has(item.selectionId)).map((item) => item.selectionId));
      saveSlip(userId, slip);
    }
    slipRef.current = slip;
  }, [slip, slipLoaded, userId]);

  // The slip changed in another tab (a pick added, removed or placed there): this one follows.
  useEffect(() => {
    if (!userId) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === slipStorageKey(userId)) setSlip(readSlip(userId));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [userId]);

  // A slip kept from last time is checked against today's prices once it's loaded.
  useEffect(() => {
    if (slipLoaded) void refreshSlip().catch(() => undefined);
  }, [slipLoaded, refreshSlip]);

  useEffect(() => {
    loadInfo().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Couldn't load your account"));
    });
  }, [loadInfo, toast, t]);

  // Why this account can't bet right now (a suspended Manager, no team yet) is a warning, shown once.
  useEffect(() => {
    if (info?.blocked) toast.warning(ts(info.blocked));
  }, [info?.blocked, toast, ts]);

  const hasLive = (events ?? []).some((event) => event.live);

  useEffect(() => {
    if (!matchParam || !events || tab !== "matches") return;
    const found = events.find((event) => event.id === matchParam && (event.bettable || event.live) && event.markets.length > 0);
    // The link is used once; a refresh of the page shouldn't jump back to it.
    router.replace("/dashboard/bet", { scroll: false });
    if (!found) {
      toast.info(t("That match isn't open for bets any more."));
      return;
    }
    setLeague("");
    setSearch("");
    setDay("");
    setFocused(found.id);
    // Far down the list: draw enough matches to reach it.
    setLimit(Math.max(MATCHES_SHOWN, events.indexOf(found) + 10));
    // The match someone came here for opens with every market showing.
    setExpanded((current) => new Set(current).add(found.id));
    void loadDetail(found.id).catch(() => undefined);
  }, [matchParam, events, tab, router, toast, t, loadDetail]);

  useEffect(() => {
    if (!focused) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(`match-${focused}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    const timer = window.setTimeout(() => setFocused(null), 4000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focused]);

  // On Open bets or Settled, the matches (live ones first) load behind, so going back to them is instant.
  useEffect(() => {
    if (tab === "matches" || lists.current.live !== null) return;
    void loadEvents().catch(() => undefined);
  }, [tab, loadEvents]);

  useEffect(() => {
    if (tab !== "matches" || !listed) return;
    loadEvents().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Couldn't load the matches"));
    });
  }, [tab, listed, loadEvents, toast, t]);

  // The sports row scrolls sideways on a narrow screen: a fade at either end shows there's more that way.
  const [sportEdges, setSportEdges] = useState({ start: false, end: false });
  const sportRowCleanup = useRef<(() => void) | null>(null);
  const sportRow = useCallback((row: HTMLDivElement | null) => {
    sportRowCleanup.current?.();
    sportRowCleanup.current = null;
    if (!row) return;
    const update = () => {
      const start = row.scrollLeft > 4;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 4;
      setSportEdges((current) => (current.start === start && current.end === end ? current : { start, end }));
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    sportRowCleanup.current = () => {
      row.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  // Prices move and matches kick off: everything every minute. Live prices are
  // pushed as they're saved (odds.live); the live matches are also fetched every
  // 30 seconds in case a push was missed. Not while the page is out of sight.
  usePolling(() => void refreshAll().catch(() => undefined), 60_000, tab === "matches" && listed);
  usePolling(() => void refreshAll("live").catch(() => undefined), 30_000, tab === "matches" && listed && hasLive);
  // Races have no prices to follow, but a race pick on the slip closes a minute before the start.
  usePolling(() => void refreshSlip().catch(() => undefined), 30_000, tab === "matches" && sport === "greyhounds" && slip.some((item) => item.sp));

  // A match closes for bets at kick-off: the list is asked again right then, not at the next minute.
  useEffect(() => {
    if (tab !== "matches" || !listed || !events) return;
    const now = Date.now();
    const next = events.reduce((soonest, event) => {
      const at = new Date(event.startsAt).getTime();
      return !event.live && at > now && at < soonest ? at : soonest;
    }, Infinity);
    if (next - now > 60_000) return;
    const timer = window.setTimeout(() => void refreshAll().catch(() => undefined), next - now + 1_000);
    return () => window.clearTimeout(timer);
  }, [events, tab, listed, refreshAll]);

  // An opened match shows every market; the others their main one.
  const merged = useMemo(
    () => (events ?? []).map((event) => (expanded.has(event.id) && details[event.id] ? { ...event, markets: details[event.id].markets, marketCount: details[event.id].marketCount } : event)),
    [events, expanded, details],
  );

  // Every price seen so far, to tell which ones moved on the latest refresh.
  const lastPrices = useRef(new Map<string, number>());
  const [moves, setMoves] = useState<Map<string, PriceMove>>(new Map());
  useEffect(() => {
    if (!events) return;
    const now = Date.now();
    const moved = new Map<string, PriceMove>();
    for (const event of merged)
      for (const market of event.markets)
        for (const selection of market.selections) {
          const before = lastPrices.current.get(selection.id);
          if (before !== undefined && before !== selection.price) moved.set(selection.id, { up: selection.price > before, until: now + MOVE_SHOWN_MS });
          lastPrices.current.set(selection.id, selection.price);
        }
    if (moved.size === 0) return;
    setMoves((current) => {
      const next = new Map(Array.from(current).filter(([, move]) => move.until > now));
      moved.forEach((move, id) => next.set(id, move));
      return next;
    });
  }, [events, merged]);

  // Arrows go away on their own once they've been showing for a while.
  useEffect(() => {
    if (moves.size === 0) return;
    const soonest = Math.min(...Array.from(moves.values(), (move) => move.until));
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setMoves((current) => new Map(Array.from(current).filter(([, move]) => move.until > now)));
    }, Math.max(0, soonest - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [moves]);

  const oddsRefresh = useRef<number | undefined>(undefined);
  const slipRecheck = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(oddsRefresh.current);
      window.clearTimeout(slipRecheck.current);
    },
    [],
  );
  /** The live list (and what's open) fetched again, once for several calls close together. */
  const refetchLive = useCallback(() => {
    window.clearTimeout(oddsRefresh.current);
    oddsRefresh.current = window.setTimeout(() => void refreshAll("live").catch(() => undefined), 400);
  }, [refreshAll]);
  useRealtime((event) => {
    // A Player's team's live prices, pushed as they're saved: applied as they come, nothing fetched.
    if (event.type === "odds.live") {
      if (sportRef.current !== "football" || !lists.current.live) return;
      const deltas = byMatch(event.events);
      const { list: live, missing } = applyToList(lists.current.live, deltas);
      if (live !== lists.current.live) {
        lists.current = { ...lists.current, live };
        setEvents([...live, ...(lists.current.upcoming ?? [])]);
      }
      if (missing) refetchLive();
      const opened = Array.from(expandedRef.current).filter((id) => deltas.has(id) && detailsRef.current[id]);
      // A market that just appeared on an open match: that match is fetched again.
      for (const id of opened) if (hasUnknownSelections(detailsRef.current[id], deltas.get(id))) void loadDetail(id).catch(() => undefined);
      if (opened.length > 0)
        setDetails((current) => {
          let next = current;
          for (const id of opened) {
            const detail = current[id];
            const updated = detail && applyDelta(detail, deltas.get(id));
            if (updated && updated !== detail) next = { ...next, [id]: updated };
          }
          return next;
        });
      const bettable = new Map(live.map((match) => [match.id, match.bettable]));
      const { items, recheck } = applyToSlip(slipRef.current, deltas, (id) => bettable.get(id));
      if (items !== slipRef.current) setSlip(items);
      if (recheck) {
        window.clearTimeout(slipRecheck.current);
        slipRecheck.current = window.setTimeout(() => void refreshSlip().catch(() => undefined), 300);
      }
      return;
    }
    if (event.type === "odds.changed") {
      refetchLive();
      return;
    }
    if (event.type === "balance.changed" || event.type === "bets.changed" || event.type === "resync") {
      void loadInfo().catch(() => undefined);
      setBetsVersion((v) => v + 1);
    }
    // Pushes sent while the stream was down are lost: the live matches are fetched again.
    if (event.type === "resync") refetchLive();
  });

  /** A new search, league or day starts again from the top of the list. */
  function filter(change: () => void) {
    change();
    setLimit(MATCHES_SHOWN);
  }

  function setTab(next: Tab) {
    router.replace(next === "matches" ? (sport === "football" ? "/dashboard/bet" : `/dashboard/bet?sport=${sport}`) : `/dashboard/bet?tab=${next}`, { scroll: false });
  }

  function setSport(next: Sport) {
    router.replace(next === "football" ? "/dashboard/bet" : `/dashboard/bet?sport=${next}`, { scroll: false });
  }

  const toggle = useCallback((event: OddsEvent, marketName: string, selection: OddsSelection) => {
    const current = slipRef.current;
    if (!current.some((item) => item.selectionId === selection.id) && current.length >= MAX_SLIP) {
      toast.error(t("A slip holds up to {max} bets.", { max: MAX_SLIP }));
      return;
    }
    setSlip((items) => {
      if (items.some((item) => item.selectionId === selection.id)) return items.filter((item) => item.selectionId !== selection.id);
      if (items.length >= MAX_SLIP) return items;
      const lastStake = items[items.length - 1]?.stake ?? "";
      return [
        ...items,
        { selectionId: selection.id, eventId: event.id, eventName: event.name, startsAt: event.startsAt, market: marketName, name: selection.name, odds: selection.price, stake: lastStake, live: event.live, sp: selection.sp, addedAt: Date.now() },
      ];
    });
  }, [toast, t]);

  const leagues = useMemo(() => Array.from(new Set((events ?? []).map((e) => e.league))).sort(), [events]);
  const query = search.trim().toLowerCase();
  const liveLabel = t("Live now");
  const endedLabel = t("Just finished");
  // Worked out again only when the matches or the filters change: typing a stake leaves them as they are.
  const { shown, allGroups, starredCount } = useMemo(() => {
    const listed = merged.filter(
      (event) => (finishedNow(event) || ((event.bettable || event.live) && event.markets.length > 0)) && (!league || event.league === league) && (!query || event.name.toLowerCase().includes(query) || event.league.toLowerCase().includes(query)),
    );
    const starredCount = listed.filter((event) => favourites.has(event.id)).length;
    const matching = favouritesOnly ? listed.filter((event) => favourites.has(event.id)) : listed;
    // Matches being played first, under "Live now" (those that can be bet on right now ahead of the paused ones);
    // those that just ended under their own heading; then the days ahead.
    const open = (event: OddsEvent) => (event.bettable && !event.allMarketsSuspended ? 0 : 1);
    const playing = matching.filter((event) => event.live && !finishedNow(event)).sort((a, b) => open(a) - open(b));
    const ended = matching.filter((event) => finishedNow(event));
    const later = matching.filter((event) => !event.live && !finishedNow(event));
    const inOrder = [...playing, ...ended, ...later];
    const allGroups: Array<[string, OddsEvent[]]> = [];
    const label = dayLabeller(i18n);
    for (const event of inOrder) {
      const heading = finishedNow(event) ? endedLabel : event.live ? liveLabel : label(event.startsAt);
      const last = allGroups[allGroups.length - 1];
      if (last && last[0] === heading) last[1].push(event);
      else allGroups.push([heading, [event]]);
    }
    // Within each heading the big matches come first: a big club playing, then the top leagues, then the rest.
    for (const group of allGroups) group[1] = byImportance(group[1]);
    return { shown: allGroups.flatMap(([, list]) => list), allGroups, starredCount };
  }, [merged, league, query, liveLabel, endedLabel, i18n, favourites, favouritesOnly]);
  // A match whose main market is paused offers another to bet on meanwhile: a live one taking bets (spread across the
  // paused ones), or failing that the next one before kick-off.
  const suggestions = useMemo(() => {
    const held = (event: OddsEvent) => {
      const main = event.markets[0];
      return !main || Boolean(main.suspended) || main.selections.every((selection) => selection.suspended);
    };
    const playing = (event: OddsEvent) => event.live && !finishedNow(event);
    const openLive = shown.filter((event) => playing(event) && event.bettable && !event.allMarketsSuspended && !held(event));
    const nextUp = shown.find((event) => !event.live && event.bettable && !held(event));
    const map = new Map<string, Suggestion>();
    shown
      .filter((event) => playing(event) && held(event))
      .forEach((event, index) => {
        const live = openLive.length > 0 ? openLive[index % openLive.length] : undefined;
        const pick = live ?? nextUp;
        if (pick && pick.id !== event.id) map.set(event.id, { id: pick.id, name: pick.name, live: Boolean(live) });
      });
    return map;
  }, [shown]);
  const goToMatch = useCallback(
    (eventId: string) => {
      const index = shown.findIndex((event) => event.id === eventId);
      if (index < 0) return;
      // A match from another day than the one picked: show every day, so it's there to scroll to.
      if (day && !(day === "live" && shown[index].live)) setDay("");
      if (index >= limit) setLimit(index + 10);
      setFocused(eventId);
    },
    [shown, limit, day],
  );
  // A day that no longer has matches (a search, a league filter) falls back to every day.
  const dayShown = day === "" ? "" : day === "live" ? liveLabel : day;
  const groups = dayShown && allGroups.some(([label]) => label === dayShown) ? allGroups.filter(([label]) => label === dayShown) : allGroups;
  // The same set while only stakes change, so the match cards don't redraw as a stake is typed.
  const selectedKey = slip.map((item) => item.selectionId).join("\n");
  const selected = useMemo(() => new Set(selectedKey ? selectedKey.split("\n") : []), [selectedKey]);
  // Only the first `limit` matches are drawn, cut across the day groups.
  let budget = limit;
  const drawn = groups
    .map(([label, dayEvents]): [string, OddsEvent[], number] => {
      const part = dayEvents.slice(0, Math.max(0, budget));
      budget -= part.length;
      return [label, part, dayEvents.length];
    })
    .filter(([, part]) => part.length > 0);
  const hidden = groups.reduce((sum, [, dayEvents]) => sum + dayEvents.length, 0) - Math.min(limit, groups.reduce((sum, [, dayEvents]) => sum + dayEvents.length, 0));

  const slipPanel = (
    <BetSlip
      items={slip}
      info={info}
      mode={slip.length >= 2 ? mode : "singles"}
      onMode={setMode}
      accaStake={accaStake}
      onAccaStake={setAccaStake}
      systemKey={systemKey}
      onSystemKey={setSystemKey}
      onChange={setSlip}
      onPlaced={() => {
        setBetsVersion((v) => v + 1);
        void loadInfo().catch(() => undefined);
      }}
      onOddsChanged={() => void refreshAll().catch(() => undefined)}
      onClose={closeSheet}
    />
  );
  const slipSystem = mode === "system" ? chosenSystem(slip, systemKey) : null;
  // The same total the slip shows: closed and paused picks aren't counted.
  const slipValid = slip.filter((item) => !item.closed && !item.paused);
  const totalStake = slipSystem
    ? Math.round(stakeValue(accaStake) * systemLineCount(slipValid.length, slipSystem.sizes.filter((size) => size <= slipValid.length)) * 100) / 100
    : mode !== "singles" && slip.length >= 2
      ? slipValid.length > 0 ? stakeValue(accaStake) : 0
      : slipValid.reduce((sum, item) => sum + stakeValue(item.stake), 0);

  // The first time, rows shaped like the matches show until the account and the matches have loaded.
  if (!info || (tab === "matches" && listed && events === null && sport === "football"))
    return failed ? null : (
      <div className="stack bet-page">
        <div className="bet-page-head">
          <h1>{t("Bet")}</h1>
        </div>
        <ListSkeleton label="Loading matches" />
      </div>
    );

  return (
    <div className="stack bet-page">
      {/* The balance is already in the top bar, so the header stays one line. */}
      <div className="bet-page-head">
        <h1>
          {t("Bet")}
          <HelpTip text="The matches for this day. Tap a price to add it to your bet slip. A higher number pays more but is less likely to win. Example: 10 ALL at 2.50 pays back 25 ALL if it wins." />
        </h1>
        <nav className="tabs-nav bet-tabs" aria-label={t("Betting sections")}>
          {(
            [
              ["matches", t("Matches")],
              ["open", t("Open bets")],
              ["settled", t("Settled")],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} type="button" className={`tab-button ${tab === key ? "is-active" : ""}`} onClick={() => setTab(key)} aria-current={tab === key ? "page" : undefined}>
              {label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "matches" ? (
        <div className={`sport-switch-wrap${sportEdges.start ? " has-more-start" : ""}${sportEdges.end ? " has-more-end" : ""}`}>
          <div ref={sportRow} className="sport-switch" role="group" aria-label={t("Sport")}>
            {(
              [
                ["football", t("Football")],
                ["greyhounds", t("Greyhounds")],
                ["tennis", t("Tennis")],
                ["basketball", t("Basketball")],
                ["volleyball", t("Volleyball")],
                ["handball", t("Handball")],
                ["nfl", t("NFL")],
                ["mma", t("MMA")],
              ] as Array<[Sport, string]>
            )
              .filter(([key]) => key !== "greyhounds" || greyhoundsOn || sport === "greyhounds")
              .map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`sport-option${sport === key ? " is-active" : ""}`}
                aria-pressed={sport === key}
                onClick={(event) => {
                  setSport(key);
                  // On a narrow screen the row scrolls: bring the chosen sport fully into view.
                  event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
                }}
              >
                <SportIcon sport={key} />
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "matches" && sport === "greyhounds" ? (
        <div className="bet-layout">
          <div className="stack bet-matches">
            <GreyhoundRaces selected={selected} onPick={toggle} active />
          </div>

        </div>
      ) : tab === "matches" ? (
        <div className="bet-layout">
          <div className={`stack bet-matches${focused ? " is-jumping" : ""}${expanded.size > 0 ? " is-reading" : ""}`}>
            <div className="bet-filters">
              <div className="bet-filters-row">
                <input type="search" placeholder={t("Search teams or leagues")} value={search} onChange={(e) => filter(() => setSearch(e.target.value))} aria-label={t("Search matches")} />
                {leagues.length > 1 ? (
                  <select className="bet-league-select" value={league} onChange={(e) => filter(() => setLeague(e.target.value))} aria-label={t("League")}>
                    <option value="">{t("All leagues")}</option>
                    {leagues.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>
            {allGroups.length > 1 || favourites.size > 0 || favouritesOnly ? (
                <div className="bet-chips bet-day-chips" role="group" aria-label={t("Day")}>
                  <button
                    type="button"
                    className={`bet-chip${groups === allGroups && !favouritesOnly ? " is-active" : ""}`}
                    onClick={() =>
                      filter(() => {
                        setDay("");
                        setFavouritesOnly(false);
                      })
                    }
                    aria-pressed={groups === allGroups && !favouritesOnly}
                  >
                    {t("All")}
                  </button>
                  {favourites.size > 0 || favouritesOnly ? (
                    <button type="button" className={`bet-chip bet-chip-favourites${favouritesOnly ? " is-active" : ""}`} onClick={() => filter(() => setFavouritesOnly(!favouritesOnly))} aria-pressed={favouritesOnly}>
                      <span aria-hidden="true">★</span>
                      {t("Favourites")}
                      <span className="bet-chip-count">{starredCount}</span>
                    </button>
                  ) : null}
                  {(allGroups.length > 1 ? allGroups : []).map(([label, list]) => {
                    const key = label === liveLabel ? "live" : label;
                    const active = groups !== allGroups && groups[0][0] === label;
                    return (
                      <button key={label} type="button" className={`bet-chip${active ? " is-active" : ""}${key === "live" ? " is-live" : ""}`} onClick={() => filter(() => setDay(active ? "" : key))} aria-pressed={active}>
                        {key === "live" ? <span className="live-dot" aria-hidden="true" /> : null}
                        {label}
                        <span className="bet-chip-count">{list.length}</span>
                      </button>
                    );
                  })}
                </div>
            ) : null}

            {events === null ? (
              <div className="loading-state">
                <LoadingSpinner label="Loading matches" />
              </div>
            ) : shown.length === 0 ? (
              <div className="card">
                <p className="muted" style={{ margin: 0 }}>
                  {favouritesOnly && events.length > 0
                    ? t("None of your favourites are on the list right now. Tap ☆ on a match to add it here.")
                    : events.length === 0
                    ? sport === "mma"
                      ? t("No fights are open for bets right now. Check back soon.")
                      : sport === "basketball"
                      ? t("No basketball games are open for bets right now. Check back soon.")
                      : sport === "nfl"
                      ? t("No NFL games are open for bets right now. Check back soon.")
                      : sport === "volleyball"
                      ? t("No volleyball matches are open for bets right now. Check back soon.")
                      : sport === "handball"
                      ? t("No handball games are open for bets right now. Check back soon.")
                      : sport === "tennis"
                      ? t("No tennis matches are open for bets right now. Check back soon.")
                      : t("No matches are open for bets right now. Check back soon.")
                    : t("No matches match your search.")}
                </p>
              </div>
            ) : (
              <>
                {drawn.map(([label, dayEvents, count]) => (
                  <section key={label} className="stack odds-day">
                    <h2 className={`odds-day-label${label === liveLabel ? " bet-live-label" : ""}`}>
                      {label === liveLabel ? <span className="live-dot" aria-hidden="true" /> : null}
                      {label}
                      <span className="odds-day-count">{count}</span>
                    </h2>
                    {label === liveLabel ? <LiveNote /> : null}
                    {byLeague(dayEvents).map((group) => (
                      <div key={group.key} className="bm-league">
                        <h3 className="bm-league-head">
                          <span className="bm-league-title">
                            {group.leagueLogo ? <img className="league-crest" src={group.leagueLogo} alt="" /> : null}
                            {group.countryFlag ? <img className="country-flag" src={group.countryFlag} alt={group.country ?? ""} /> : null}
                            <span className="bm-league-name">{group.league}</span>
                            {visibleCountry(group.country, group.countryFlag) ? <span className="bm-league-country">{group.country}</span> : null}
                          </span>
                          <span className="bm-odds-legend" aria-hidden="true">
                            {resultHeads(group.events[0]?.markets[0]?.selections).map((label) => (
                              <span key={label}>{label}</span>
                            ))}
                          </span>
                          <span className="bm-league-count">{group.events.length}</span>
                        </h3>
                        {group.events.map((event) => (
                          <MatchCard
                            key={event.id}
                            event={event}
                            selected={selected}
                            onPick={toggle}
                            focused={focused === event.id}
                            moves={moves}
                            expanded={expanded.has(event.id)}
                            loading={expanded.has(event.id) && !details[event.id]}
                            onToggle={toggleExpanded}
                            onPrefetch={prefetchDetail}
                            starred={favourites.has(event.id)}
                            onStar={toggleFavourite}
                            favouriteMarkets={favouriteMarkets}
                            onStarMarket={toggleFavouriteMarket}
                            suggestion={suggestions.get(event.id)}
                            onGoTo={goToMatch}
                          />
                        ))}
                      </div>
                    ))}
                  </section>
                ))}
                {hidden > 0 ? (
                  <button type="button" className="secondary bet-show-more" onClick={() => setLimit(limit + MATCHES_SHOWN)}>
                    {tn(hidden, "Show more matches ({count} more)", "Show more matches ({count} more)")}
                  </button>
                ) : null}
              </>
            )}
          </div>

        </div>
      ) : (
        <MyBetsList status={tab} version={betsVersion} />
      )}

      {slip.length > 0 && tab === "matches" && !sheetOpen ? (
        <button type="button" className="bet-slip-bar" onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
          <span className="bet-slip-count">{slip.length}</span>
          <span>{t("Bet slip")}</span>
          <span className="bet-slip-bar-total">{totalStake > 0 ? formatMoney(totalStake) : t("Add stakes")}</span>
        </button>
      ) : null}

      {sheetOpen ? (
        <div className="bet-sheet-layer" role="dialog" aria-modal="true" aria-label={t("Bet slip")}>
          <button type="button" className="bet-sheet-backdrop" aria-label={t("Close bet slip")} onClick={closeSheet} />
          {/* A tap beside the slip (wide screens) closes it, like the backdrop. */}
          <div className="bet-sheet" onClick={(event) => event.target === event.currentTarget && closeSheet()}>
            {slipPanel}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The headings an opened match's markets sit under, in this order. */
const MARKET_GROUPS = [
  ["main", msg("Main")],
  ["goals", msg("Goals")],
  ["teams", msg("Teams")],
  ["halves", msg("Halves")],
  ["combos", msg("Combos")],
  ["scorers", msg("Goalscorers")],
  ["corners", msg("Corners & cards")],
  ["rounds", msg("Rounds")],
  ["handicap", msg("Handicap")],
  ["points", msg("Total points")],
  ["sets", msg("Sets")],
  ["games", msg("Games")],
  ["quarters", msg("Quarters")],
] as const;
type MarketGroup = (typeof MARKET_GROUPS)[number][0];

function marketGroup(key: string): MarketGroup {
  // Basketball and the NFL: the result, handicap and points lines, the halves, then the quarters.
  if (["bb_winner", "bb_3way", "bb_double_chance", "bb_ht_ft"].includes(key)) return "main";
  if (key.startsWith("bb_handicap_")) return "handicap";
  if (/^bb_(total_|home_total_|away_total_|odd_even)/.test(key)) return "points";
  if (/^bb_(h1|h2)_/.test(key) || key === "bb_highest_half") return "halves";
  if (/^bb_q[1-4]_/.test(key)) return "quarters";
  // Volleyball: the match in sets, then the points lines, then the 1st, 2nd and 3rd sets. (Handball uses football's keys.)
  if (key === "vb_winner" || key === "vb_correct_score" || key === "vb_s1_match" || /^vb_(sets_|4th_set|5th_set|home_wins_set|away_wins_set)/.test(key)) return "main";
  if (/^vb_(points_handicap|points_total|home_points|away_points|odd_even)/.test(key)) return "points";
  if (/^vb_s[1-3]_/.test(key)) return "sets";
  // Tennis: who wins the match, then the sets (the 1st set and the score in sets), then games.
  if (key === "tn_winner" || key === "tn_set_match" || /^tn_(straight|one_set|behind)_/.test(key)) return "main";
  if (/^tn_(games|handicap|home_games|away_games)_/.test(key) || key === "tn_odd_even") return "games";
  if (key.startsWith("tn_")) return "sets";
  // MMA: who wins, then the rounds lines.
  if (key.startsWith("fight_")) return "main";
  if (/^rounds_\d+_5$/.test(key)) return "rounds";
  if (["match_winner", "double_chance", "draw_no_bet", "btts"].includes(key)) return "main";
  if (/^(ah|eh)_/.test(key)) return "handicap";
  if (/^(home_|away_)?(corners|cards)_/.test(key)) return "corners";
  if (key.startsWith("scorer_")) return "scorers";
  if (/^(result_goals|goals_btts)_/.test(key) || key === "result_btts") return "combos";
  if (/^h[12]_/.test(key) || ["ht_ft", "highest_half", "win_both_halves", "win_either_half"].includes(key)) return "halves";
  if (/^goals_\d/.test(key) || ["exact_goals", "goal_range", "odd_even", "correct_score", "winning_margin"].includes(key)) return "goals";
  return "teams";
}

/** The heading over an opened match's starred markets. */
const FAVOURITES_GROUP = msg("Favourites");

/** Players shown in a goalscorer market before "Show all players". */
const SCORERS_SHOWN = 12;
/** A match's stats button shows from this long before kick-off, for the line-ups (the API fetches them from then too). */
const STATS_BEFORE_MS = 90 * 60_000;

/** Drawn again only when its own props change: a list of 240 matches redrawing on every keystroke made typing a stake lag. */
const MatchCard = memo(function MatchCard({
  event,
  selected,
  onPick,
  focused,
  moves,
  expanded,
  loading,
  onToggle,
  onPrefetch,
  starred,
  onStar,
  favouriteMarkets,
  onStarMarket,
  suggestion,
  onGoTo,
}: {
  event: OddsEvent;
  selected: Set<string>;
  onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void;
  focused: boolean;
  moves: Map<string, PriceMove>;
  /** Every market showing (they load when the match is opened). */
  expanded: boolean;
  loading: boolean;
  onToggle: (eventId: string) => void;
  /** About to open: start loading its markets. */
  onPrefetch: (eventId: string) => void;
  /** In this account's favourites. */
  starred: boolean;
  onStar: (eventId: string) => void;
  /** The kinds of market this account starred: they open first, under Favourites. */
  favouriteMarkets: Set<string>;
  onStarMarket: (kind: string) => void;
  /** While its main market is paused: another match to bet on meanwhile, shown in that row instead of locked prices. */
  suggestion?: Suggestion;
  onGoTo: (eventId: string) => void;
}) {
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  /** Goalscorer markets showing every player. */
  const [allPlayers, setAllPlayers] = useState<Set<string>>(new Set());
  const [statsOpen, setStatsOpen] = useState(false);
  /**
   * The markets the Player opened or closed in this match: a market's key, or
   * a line family's first key. Markets start closed, favourite ones open, so
   * this holds the ones that differ from that.
   */
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const over = finishedNow(event);
  // Football has stats once it's under way, and the line-ups from shortly before.
  const hasStats = (event.sport ?? "football") === "football" && (event.live || over || new Date(event.startsAt).getTime() - Date.now() < STATS_BEFORE_MS);
  // The row carries the main market when it fits in three columns; everything else opens below it.
  // A finished match shows its final score and no prices.
  const main = over ? undefined : event.markets[0];
  const inRow = main && main.selections.length <= 3 ? main : undefined;
  const below = over || !expanded ? [] : event.markets.filter((market) => market.id !== inRow?.id);
  const more = over ? 0 : Math.max(0, event.marketCount - (inRow ? 1 : 0));
  const bundled = MARKET_GROUPS.map(([id, label]) => [label as string, bundleLines(below.filter((market) => marketGroup(market.key) === id))] as const);
  type Entry = (typeof bundled)[number][1][number];
  const entryKey = (entry: Entry) => ("kind" in entry ? entry.lines[0].key : entry.key);
  const isFavourite = (entry: Entry) => favouriteMarkets.has(marketKind("kind" in entry ? entry.lines[0] : entry));
  // Starred kinds of market come out of their groups into Favourites, on top.
  const favourite = bundled.flatMap(([, list]) => list.filter(isFavourite));
  const hasPick = (markets: Array<{ selections: OddsSelection[] }>) => markets.some((market) => market.selections.some((selection) => selected.has(selection.id)));
  const playing = event.live && !finishedNow(event);
  // During play, markets the feed hasn't priced for a while go out of the way, into "Not available during play" at
  // the bottom, closed; one holding a pick on the slip stays where it is. A market paused for a moment stays in place.
  const staleMarket = (market: { stale?: boolean }) => Boolean(market.stale);
  const unavailable = (entry: Entry) => playing && ("kind" in entry ? entry.lines.every(staleMarket) && !hasPick(entry.lines) : staleMarket(entry) && !hasPick([entry]));
  const grouped = [...(favourite.length > 0 ? [[FAVOURITES_GROUP, favourite] as const] : []), ...bundled.map(([label, list]) => [label, list.filter((entry) => !isFavourite(entry))] as const)]
    .map(([label, list]) => [label, list.filter((entry) => !unavailable(entry))] as const)
    .filter(([, list]) => list.length > 0);
  const offBoard = bundled.flatMap(([, list]) => list.filter(unavailable));
  const [showOffBoard, setShowOffBoard] = useState(false);
  const entries = grouped.flatMap(([, list]) => list);
  const isOpen = (entry: Entry) => isFavourite(entry) !== flipped.has(entryKey(entry));
  const allOpen = entries.length > 0 && entries.every(isOpen);
  const flip = (key: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Starring or unstarring moves a market between Favourites (open) and its group (closed): it starts afresh there.
  const starMarket = (entry: Entry) => {
    setFlipped((current) => {
      const next = new Set(current);
      next.delete(entryKey(entry));
      return next;
    });
    onStarMarket(marketKind("kind" in entry ? entry.lines[0] : entry));
  };
  const toggleLabel = expanded ? t("Fewer markets") : tn(more, "{count} more market", "{count} more markets");
  const scored = (event.live || over) && event.homeScore !== null && event.awayScore !== null;
  const mainHeld = Boolean(playing && inRow && (inRow.suspended || inRow.selections.every((selection) => selection.suspended)));
  const rowOpen = (market: OddsEvent["markets"][number]) => !market.suspended && !market.stale && market.selections.some((selection) => !selection.suspended);
  const winnerHeld = playing && event.bettable && !event.marketPause && Boolean(inRow && inRow.key === "match_winner" && mainHeld && event.markets.some((market) => market.id !== inRow.id && rowOpen(market)));
  const pause = over
    ? { text: breakPause(event) ?? "", tone: " is-finished" }
    : event.live && !event.bettable
      ? {
          text:
            event.livePause === "bookmaker" && event.marketPause
              ? msg("The bookmaker has blocked this match during the pause. They reopen on their own. Our pause still ends on the line below.")
              : event.livePause === "late" || event.livePause === "competition"
                ? PAUSE_TEXT[event.livePause]
                : breakPause(event) ?? PAUSE_TEXT[event.livePause ?? "feed"] ?? PAUSE_TEXT.feed,
          tone: "",
        }
      : event.live && event.allMarketsSuspended
        ? { text: PAUSE_TEXT.bookmaker, tone: "" }
        : winnerHeld
          ? { text: msg("The bookmaker has paused the match winner. The other markets are still open."), tone: "" }
          : null;
  // The main market paused with nothing of it on the slip: another match to bet on in its place, rather than locked prices.
  const suggest = suggestion && mainHeld && !over && !(inRow && hasPick([inRow])) ? suggestion : undefined;

  const pick = (market: OddsEvent["markets"][number], selection: OddsSelection, label: string, className: string) => {
    const isSelected = selected.has(selection.id);
    // A pause still shows the last price, greyed out, and won't take the bet.
    // A dash is only for an outcome that has no price at all.
    const offBoard = Boolean(market.suspended || selection.suspended);
    const locked = !event.bettable || offBoard;
    return (
      <button
        key={selection.id}
        type="button"
        className={`${className}${isSelected ? " is-selected" : ""}${offBoard ? " is-held" : ""}`}
        onClick={() => onPick(event, market.name, selection)}
        aria-pressed={isSelected}
        disabled={locked && !isSelected}
        aria-label={t(locked ? "{pick} at {odds}, {market}, {match}, suspended" : "{pick} at {odds}, {market}, {match}", { pick: pickLabel(selection.name, i18n), odds: selection.price.toFixed(2), market: ts(market.name), match: event.name })}
      >
        <span className="odds-selection-name">{label}</span>
        <strong className={`odds-price${offBoard ? " is-held" : ""}`}>
          {offBoard && selection.price <= 1 ? "–" : selection.price.toFixed(2)}
          {offBoard ? null : <PriceArrow move={moves.get(selection.id)} />}
        </strong>
      </button>
    );
  };

  /** One market, or a family of lines, with its head and (when open) its prices. */
  const renderEntry = (entry: Entry, quiet = false) => {
    const key = entryKey(entry);
    const open = isOpen(entry);
    const starred = isFavourite(entry);
    if ("kind" in entry) {
      return (
        <LineFamily key={key} lines={entry.lines} open={open} onToggle={() => flip(key)} picked={hasPick(entry.lines)} starred={starred} onStar={() => starMarket(entry)} quiet={quiet}>
          {(market) => marketOutcomes(market)}
        </LineFamily>
      );
    }
    const scorers = entry.key.startsWith("scorer_");
    return (
      <div key={key} className={`odds-market${open ? " is-open" : ""}`}>
        <MarketHead title={ts(entry.name)} suspended={entry.suspended} paused={Boolean(entry.paused)} quiet={quiet} open={open} onToggle={() => flip(key)} picked={hasPick([entry])} starred={starred} onStar={() => starMarket(entry)}>
          {scorers ? null : <MarketPriceHistory selections={entry.selections} compact />}
        </MarketHead>
        {open ? marketOutcomes(entry) : null}
      </div>
    );
  };

  const marketOutcomes = (market: OddsEvent["markets"][number]) => {
    const offered = market.selections.filter((selection) => !(selection.suspended && !market.suspended && market.selections.length > 3 && !selected.has(selection.id)));
    const scorers = market.key.startsWith("scorer_");
    const scores = market.key === "correct_score" || market.key.endsWith("_correct_score");
    const margin = market.key === "winning_margin" || market.key.endsWith("_winning_margin");
    const limit = scorers ? SCORERS_SHOWN : 12;
    const showAll = (!scorers && !scores) || allPlayers.has(market.id) || offered.length <= limit + 2;
    const visible = showAll ? offered : offered.filter((selection, index) => index < limit || selected.has(selection.id));
    return (
      <>
        <div className={`odds-selections${scorers ? " is-players" : ""}${margin ? " is-margin" : ""}`}>{visible.map((selection) => pick(market, selection, pickLabel(selection.name, i18n), "odds-selection bet-pick"))}</div>
        {!showAll ? (
          <button type="button" className="text-button bet-all-players" onClick={() => setAllPlayers((current) => new Set(current).add(market.id))}>
            {scorers ? tn(offered.length, "Show all {count} players", "Show all {count} players") : tn(offered.length, "Show all {count} scores", "Show all {count} scores")}
          </button>
        ) : null}
        {/^(home_|away_)?cards_/.test(market.key) ? <p className="muted odds-market-rule">{t("Settles on the official match stats after 90 minutes. Every yellow and red card counts as 1.")}</p> : null}
        {/^(home_|away_)?corners_/.test(market.key) ? <p className="muted odds-market-rule">{t("Settles on the official match stats after 90 minutes.")}</p> : null}
        {market.key === "scorer_first" ? (
          <p className="muted odds-market-rule">{t("Own goals don't count. If your player doesn't play, or comes on after the first goal, your stake comes back.")}</p>
        ) : scorers ? (
          <p className="muted odds-market-rule">{t("Own goals don't count. If your player doesn't play, your stake comes back.")}</p>
        ) : null}
        {market.key === "first_team_score" || market.key === "last_team_score" ? <p className="muted odds-market-rule">{t("An own goal counts for the team it's given to.")}</p> : null}
      </>
    );
  };

  return (
    <article id={`match-${event.id}`} className={`bm-match${playing ? " is-live" : ""}${over ? " is-over" : ""}${focused ? " is-focused" : ""}${expanded ? " is-expanded" : ""}`}>
      <div className="bm-row">
        <button type="button" className={`match-star${starred ? " is-starred" : ""}`} onClick={() => onStar(event.id)} aria-pressed={starred} aria-label={starred ? t("Remove {match} from favourites", { match: event.name }) : t("Add {match} to favourites", { match: event.name })}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
          </svg>
        </button>
        <div className="bm-when">
          {playing || over ? (
            <>
              {playing ? <span className="live-dot" aria-hidden="true" /> : null}
              <span>{liveClock(event, t)}</span>
            </>
          ) : (
            <time dateTime={event.startsAt}>{date(event.startsAt, TIME)}</time>
          )}
        </div>
        <div className="bm-teams">
          <div className="bm-team-block">
            <span className="bm-team">
              <span className="bm-side">
                <TeamCrest name={event.homeTeam ?? event.name} logo={event.homeLogo} />
                <span className="bm-team-name">{event.homeTeam ?? event.name}</span>
              </span>
            </span>
            {event.awayTeam ? (
              <span className="bm-team">
                <span className="bm-side">
                  <TeamCrest name={event.awayTeam} logo={event.awayLogo} />
                  <span className="bm-team-name">{event.awayTeam}</span>
                </span>
              </span>
            ) : null}
          </div>
          <div className="bm-score-col">
            {scored ? <span className="bm-score">{event.homeScore}</span> : null}
            {scored && event.awayTeam ? <span className="bm-score">{event.awayScore}</span> : null}
          </div>
          <div className="bm-tools">
            {hasStats ? (
              <button type="button" className={`bm-icon${statsOpen ? " is-active" : ""}`} onClick={() => setStatsOpen((open) => !open)} aria-pressed={statsOpen} aria-label={statsOpen ? t("Hide stats") : t("Stats")} title={statsOpen ? t("Hide stats") : t("Stats")}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 20V11M12 20V4M19 20v-6" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
        <div className={`bm-odds${inRow ? ` has-${inRow.selections.length}` : ""}`}>
          {over ? (
            <span className="bm-settled">{t("Settling")}</span>
          ) : suggest ? (
            <button type="button" className="bm-suggest" onClick={() => onGoTo(suggest.id)} title={suggest.name}>
              <span className="bm-suggest-label">{suggest.live ? t("Meanwhile, live") : t("Meanwhile")}</span>
              <span className="bm-suggest-name">{suggest.name}</span>
              <span aria-hidden="true">›</span>
            </button>
          ) : inRow ? (
            inRow.selections.map((selection) => pick(inRow, selection, rowLabel(selection, i18n), "bm-pick"))
          ) : null}
        </div>
        {more > 0 ? (
          <button type="button" className={`bm-more${expanded ? " is-open" : ""}`} onClick={() => onToggle(event.id)} onPointerEnter={() => !expanded && onPrefetch(event.id)} onTouchStart={() => !expanded && onPrefetch(event.id)} onFocus={() => !expanded && onPrefetch(event.id)} aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel}>
            {expanded ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 15 6-6 6 6" />
              </svg>
            ) : (
              <>
                <span className="bm-more-count">{more}</span>
                <span className="bm-more-word">{tn(more, "market", "markets")}</span>
              </>
            )}
          </button>
        ) : (
          <span className="bm-more-spacer" aria-hidden="true" />
        )}
      </div>
      {pause ? <p className={`bet-paused bm-note${pause.tone}`}>{t(pause.text)}</p> : null}
      {!over && event.live && event.marketPause ? <PauseBanner pause={event.marketPause} /> : null}
      {statsOpen ? (
        <div className="bm-stats">
          <MatchStatsPanel eventId={event.id} name={event.name} live={event.live} />
        </div>
      ) : null}
      {expanded ? (
        <div className="bm-detail">
          {inRow ? <p className="bm-detail-main">{ts(inRow.name)}</p> : null}
          {entries.length > 1 ? (
            <div className="bm-detail-tools">
              <button
                type="button"
                className="text-button bm-open-all"
                // Open all: every market that isn't open on its own (not a favourite). Close all: every favourite.
                onClick={() => setFlipped(new Set(entries.filter((entry) => isFavourite(entry) === allOpen).map(entryKey)))}
                aria-pressed={allOpen}
              >
                {allOpen ? t("Close all") : t("Open all")}
              </button>
            </div>
          ) : null}
          {grouped.map(([label, list]) => (
            <div key={label} className={`odds-market-group${label === FAVOURITES_GROUP ? " is-favourites" : ""}`}>
              {grouped.length > 1 || label === FAVOURITES_GROUP ? <h3 className="odds-market-group-title">{t(label)}</h3> : null}
              {list.map((entry) => renderEntry(entry))}
            </div>
          ))}
          {offBoard.length > 0 ? (
            <div className="odds-market-group is-unavailable">
              <button type="button" className="text-button odds-unavailable-toggle" onClick={() => setShowOffBoard((open) => !open)} aria-expanded={showOffBoard}>
                {tn(offBoard.length, "Not available during play ({count} market)", "Not available during play ({count} markets)")}
                <span aria-hidden="true">{showOffBoard ? " ▴" : " ▾"}</span>
              </button>
              {showOffBoard ? (
                <>
                  <p className="muted odds-market-rule">{t("Our feed hasn't priced these during play for a while. They come back to the list if it does.")}</p>
                  {offBoard.map((entry) => renderEntry(entry, true))}
                </>
              ) : null}
            </div>
          ) : null}
          {loading ? (
            <div className="loading-state bet-markets-loading">
              <LoadingSpinner label="Loading markets" />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

/** A pick's name in the match row: 1, X and 2 for the result, otherwise its own name. */
function rowLabel(selection: OddsSelection, i18n: I18n): string {
  if (selection.key === "home") return "1";
  if (selection.key === "draw") return "X";
  if (selection.key === "away") return "2";
  return pickLabel(selection.name, i18n);
}

/** A day's matches by competition, in the order the competitions first come up. */
function byLeague(events: OddsEvent[]): Array<{ key: string; league: string; country: string | null; leagueLogo: string | null; countryFlag: string | null; events: OddsEvent[] }> {
  const groups = new Map<string, { key: string; league: string; country: string | null; leagueLogo: string | null; countryFlag: string | null; events: OddsEvent[] }>();
  for (const event of events) {
    const key = `${event.country ?? ""}|${event.league}`;
    const group = groups.get(key);
    if (group) {
      group.events.push(event);
      group.leagueLogo ??= event.leagueLogo ?? null;
      group.countryFlag ??= event.countryFlag ?? null;
    } else groups.set(key, { key, league: event.league, country: event.country, leagueLogo: event.leagueLogo ?? null, countryFlag: event.countryFlag ?? null, events: [event] });
  }
  return Array.from(groups.values());
}

/**
 * The Place button while a live bet is confirmed: a spinner and about how many seconds are left until
 * `deadline` (ms), when the API should answer: the wait it gives this slip (bets.service plannedWait) plus
 * about a second for its checks with the feed. Past it, it says it's nearly done.
 */
function LiveCountdown({ deadline }: { deadline: number }) {
  const { t } = useI18n();
  const secondsLeft = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const [left, setLeft] = useState(secondsLeft);
  // Worked out from the deadline on every tick, never counted down: a tab the browser slows down still shows the true time.
  useEffect(() => {
    setLeft(secondsLeft());
    const timer = window.setInterval(() => setLeft(secondsLeft()), 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);
  return (
    <span className="bet-live-countdown" role="status">
      <LoadingSpinner label="Confirming live bet" size="small" />
      <span aria-live="off">{left > 0 ? t("Confirming live bet · about {seconds} s", { seconds: left }) : t("Almost done…")}</span>
    </span>
  );
}

/**
 * Above the live matches: why betting pauses after a goal, and why a live bet takes a few seconds. Closed for
 * good with its ✕ (kept in this browser).
 */
function LiveNote() {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(LIVE_NOTE_KEY) === "hidden");
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  return (
    <div className="bet-live-note" role="note">
      <span className="bet-live-note-icon" aria-hidden="true">i</span>
      <p>
        {t("Betting pauses briefly after goals so prices stay fair. Bets placed after a goal that hasn't shown yet are voided and your stake is returned.")}
      </p>
      <button
        type="button"
        className="text-button bet-live-note-close"
        aria-label={t("Hide this note")}
        onClick={() => {
          setHidden(true);
          try {
            window.localStorage.setItem(LIVE_NOTE_KEY, "hidden");
          } catch {
            // Hidden for this visit.
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}
const LIVE_NOTE_KEY = "bastal-live-note";

/** The Player's choice of what to do with a price that moves before a bet goes in, kept in this browser. */
type PriceChanges = "never" | "higher";
const PRICE_CHANGES_KEY = "bastal-price-changes";
function usePriceChangeSetting(): [PriceChanges, (value: PriceChanges) => void] {
  const [value, setValue] = useState<PriceChanges>("higher");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(PRICE_CHANGES_KEY) === "never") setValue("never");
    } catch {
      // The default stands.
    }
  }, []);
  const save = useCallback((next: PriceChanges) => {
    setValue(next);
    try {
      window.localStorage.setItem(PRICE_CHANGES_KEY, next);
    } catch {
      // Kept for this visit.
    }
  }, []);
  return [value, save];
}

/** Just finished: the live list keeps it a few minutes, marked full time, instead of dropping it. */
function finishedNow(event: OddsEvent): boolean {
  return event.status === "COMPLETED" || (event.live && event.period === "FT");
}

/** Why a live match isn't taking bets, in words a Player understands. */
const PAUSE_TEXT: Record<string, string> = {
  late: msg("Live betting has closed for the last minutes of this match."),
  competition: msg("Pre-match only: our feed for this competition is too slow for live betting."),
  feed: msg("Live betting is paused until this match's prices come back."),
  bookmaker: msg("The bookmaker has paused bets on this match. They reopen on their own."),
};

/** Another match to bet on while one's main market is paused. */
type Suggestion = { id: string; name: string; live: boolean };

/** What paused the markets, in the banner. */
const PAUSE_REASON: Record<string, string> = {
  goal: msg("⚽ Goal"),
  ahead: msg("Score not confirmed yet"),
  red: msg("🟥 Red card"),
  corner: msg("Corner"),
  yellow: msg("Yellow card"),
  var: msg("VAR check"),
  swing: msg("Big moment in the match"),
  reopen: msg("Betting reopening"),
};

/**
 * A live match's paused markets: what paused them, which (the first few),
 * and when they're back, counting down: "Back in" when fresh prices are in
 * and the time is known, "Back within" while it's only the latest it can be.
 */
function PauseBanner({ pause }: { pause: MarketPause }) {
  const { t, tn, ts } = useI18n();
  const until = new Date(pause.until).getTime();
  // Read on the device after it's drawn (never on the server), then every second.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(serverNow());
    const timer = window.setInterval(() => setNow(serverNow()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = now === null ? null : Math.max(0, Math.ceil((until - now) / 1000));
  if (now !== null && now >= until) return null;
  const names = pause.markets.map((name) => ts(name)).join(", ");
  const others = pause.count - pause.markets.length;
  const markets = others > 0 ? tn(others, "{markets} and {count} more", "{markets} and {count} more", { markets: names }) : names;
  return (
    <p className={`bet-paused bm-note bm-pause${pause.reason === "goal" ? " is-goal" : ""}`} role="status">
      <strong>{t(PAUSE_REASON[pause.reason] ?? PAUSE_REASON.swing)}</strong>
      {" · "}
      {t("Paused: {markets}.", { markets })}{" "}
      {seconds === null ? null : (
        <span className="bm-pause-time">{seconds === 0 ? t("Back any moment.") : pause.exact ? t("Back in {seconds} s.", { seconds }) : t("Back within {seconds} s.", { seconds })}</span>
      )}
    </p>
  );
}

/** A green up arrow when a price went up, a red down arrow when it went down; nothing when it didn't move. */
function PriceArrow({ move }: { move: PriceMove | undefined }) {
  const { t } = useI18n();
  if (!move) return null;
  return (
    <span className={`price-arrow ${move.up ? "is-up" : "is-down"}`} role="img" aria-label={move.up ? t("Price went up") : t("Price went down")}>
      {move.up ? "▲" : "▼"}
    </span>
  );
}

function BetSlip({
  items,
  info,
  mode,
  onMode,
  accaStake,
  onAccaStake,
  systemKey,
  onSystemKey,
  onChange,
  onPlaced,
  onOddsChanged,
  onClose,
}: {
  items: SlipItem[];
  info: SlipInfo | null;
  mode: SlipMode;
  onMode: (mode: SlipMode) => void;
  accaStake: string;
  onAccaStake: (stake: string) => void;
  systemKey: string;
  onSystemKey: (key: string) => void;
  onChange: (update: (items: SlipItem[]) => SlipItem[]) => void;
  onPlaced: () => void;
  onOddsChanged: () => void;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts } = i18n;
  const idempotency = useIdempotencyKey();
  const topUp = useTopUpRequest();
  const [placing, setPlacing] = useState(false);
  // Set in the same turn as the click, so a second tap during the countdown cannot start another bet.
  const placingRef = useRef(false);
  /** Set when a place was refused because the price moved, so the retry takes that new price. */
  const [takeNewPrice, setTakeNewPrice] = useState(false);
  const toast = useToast();
  const [receipt, setReceipt] = useState<PlaceBetsResponse | null>(null);
  const router = useRouter();
  /** When a live slip being confirmed should be answered (ms), for the countdown. */
  const [deadline, setDeadline] = useState(0);
  // Removing the last pick closes the sheet instead of leaving an empty slip over the page. Placing keeps it open, for the receipt.
  const hadItems = useRef(items.length > 0);
  useEffect(() => {
    if (hadItems.current && items.length === 0 && !receipt) onClose();
    hadItems.current = items.length > 0;
  }, [items.length, receipt, onClose]);

  // Combined picks all from one match are a bet builder, priced by the server; from different matches, an accumulator.
  const oneMatch = items.length >= 2 && new Set(items.map((item) => item.eventId)).size === 1;
  // The bet builder is for matches that haven't started: picks all from one live match can only be singles.
  const liveBuilder = oneMatch && items.some((item) => item.live);
  const canCombine = items.length >= 2 && !liveBuilder;
  // A system: every double, treble… of picks from different matches, the same stake on each line.
  const systemChoice = chosenSystem(items, systemKey);
  const system = mode === "system" && systemChoice !== null;
  const combined = canCombine && (mode === "accumulator" || (mode === "system" && !system));
  const builder = combined && oneMatch;
  const acca = combined && !oneMatch;
  const [builderQuote, setBuilderQuote] = useState<{ key: string; odds: number | null; error: string | null } | null>(null);
  const [requote, setRequote] = useState(0);
  const builderKey = builder ? `${items.map((item) => `${item.selectionId}:${item.odds}`).join(",")}#${requote}` : "";
  useEffect(() => {
    if (!builderKey) return;
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      if (!token || cancelled) return;
      try {
        const quote = await apiFetch<BuilderQuote>("/bets/builder/quote", token, { method: "POST", body: JSON.stringify({ selectionIds: builderKey.split("#")[0].split(",").map((part) => part.split(":")[0]) }) });
        if (!cancelled) setBuilderQuote({ key: builderKey, odds: quote.odds, error: null });
      } catch (err) {
        if (!cancelled) setBuilderQuote({ key: builderKey, odds: null, error: err instanceof Error ? err.message : t("Couldn't price this bet builder") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [builderKey, getToken, t]);
  const quote = builder && builderQuote?.key === builderKey ? builderQuote : null;
  const builderOdds = quote?.odds ?? 0;
  const hasSp = items.some((item) => item.sp);
  // Closed or paused picks can't be bet on: they're greyed out and left out of every total (odds, stake, return)
  // until they reopen or are removed.
  const valid = items.filter((item) => !item.closed && !item.paused);
  const accaOdds = combinedOdds(valid.map((item) => item.odds));
  const accaStakeValue = stakeValue(accaStake);
  const sameMatch = new Set(items.map((item) => item.eventId)).size < items.length;

  // A system over the picks that can be bet on: its line sizes that still fit, and how many lines that makes.
  const systemSizes = system ? systemChoice.sizes.filter((size) => size <= valid.length) : [];
  const systemLines = system ? systemLineCount(valid.length, systemSizes) : 0;
  const totalStake = system ? Math.round(accaStakeValue * systemLines * 100) / 100 : combined ? (valid.length > 0 ? accaStakeValue : 0) : valid.reduce((sum, item) => sum + stakeValue(item.stake), 0);
  // Race picks pay the starting price, so they add nothing known to the return.
  const totalReturn = system
    ? systemMaxReturn(valid.map((item) => item.odds), systemSizes, accaStakeValue)
    : builder ? returns(accaStakeValue, builderOdds) : acca ? returns(accaStakeValue, accaOdds) : valid.reduce((sum, item) => sum + (item.sp ? 0 : returns(stakeValue(item.stake), item.odds)), 0);
  const missingStake = system ? accaStakeValue < MIN_SYSTEM_LINE_STAKE || totalStake < 1 : combined ? accaStakeValue < 1 : valid.some((item) => stakeValue(item.stake) < 1);
  const closed = items.filter((item) => item.closed);
  const paused = items.filter((item) => item.paused && !item.closed);
  const hasLive = items.some((item) => item.live);
  // How long this slip would wait if placed now, from the API: the countdown and the note below say the same.
  const [planned, setPlanned] = useState<LiveWait | null>(null);
  const liveKey = hasLive ? items.map((item) => item.selectionId).join(",") : "";
  const loadPlanned = useCallback(async (): Promise<LiveWait | null> => {
    if (!liveKey) return null;
    const token = await getToken();
    if (!token) return null;
    const wait = await apiFetch<LiveWait>("/bets/live-wait", token, { method: "POST", body: JSON.stringify({ selectionIds: liveKey.split(",") }) });
    setPlanned(wait);
    return wait;
  }, [liveKey, getToken]);
  useEffect(() => {
    if (!liveKey) {
      setPlanned(null);
      return;
    }
    void loadPlanned().catch(() => undefined);
    // A match turns busy (a goal) or quiet again: asked again now and then.
    const timer = window.setInterval(() => void loadPlanned().catch(() => undefined), 20_000);
    return () => window.clearInterval(timer);
  }, [liveKey, loadPlanned]);
  /** Seconds a live slip takes: the wait, and about a second for the checks after it. */
  const liveSeconds = planned?.live ? Math.ceil((planned.waitMs + CHECK_TYPICAL_MS) / 1000) : null;
  const overMax = info?.maxStake != null ? (system ? totalStake > info.maxStake : combined ? accaStakeValue > info.maxStake : items.some((item) => stakeValue(item.stake) > info.maxStake!)) : false;
  const tooLittle = info ? totalStake > info.balance : false;
  /** What a top-up request from the slip asks for: what's missing for it, in whole ALL. */
  const shortfall = info && tooLittle ? Math.ceil(totalStake - info.balance) : undefined;
  const moved = items.some((item) => item.previousOdds !== undefined);
  const priceMoved = moved || takeNewPrice;
  // What to do when a price moves between the tap and the bet going in (before kick-off; a live bet is only ever
  // placed at the price on the slip): "never" asks every time, "higher" takes a better price on its own.
  const [priceChanges, setPriceChanges] = usePriceChangeSetting();
  const movedItems = items.filter((item) => item.previousOdds !== undefined && !item.closed);
  /** What the slip would have returned at the prices it was added at, to show beside the new return. */
  const returnBefore = moved
    ? (() => {
        const before = valid.map((item) => ({ ...item, odds: item.previousOdds ?? item.odds }));
        if (system) return systemMaxReturn(before.map((item) => item.odds), systemSizes, accaStakeValue);
        if (acca) return returns(accaStakeValue, combinedOdds(before.map((item) => item.odds)));
        if (builder) return null;
        return before.reduce((sum, item) => sum + (item.sp ? 0 : returns(stakeValue(item.stake), item.odds)), 0);
      })()
    : null;
  const modeHint =
    items.length === 1
      ? t("Add another selection to build an accumulator.")
      : liveBuilder
        ? t("The bet builder is for matches that haven't started. Picks from this live match can only be singles.")
        : !oneMatch && items.length === 2
          ? t("Add a third selection from another match for a system bet.")
          : !oneMatch && !systemChoice && items.length >= 3
            ? t("A system bet needs every pick from a different match.")
            : null;
  const summaryTitle = system
    ? tn(systemLines, "{count} bet", "{count} bets", { count: systemLines })
    : builder
      ? t("Bet builder")
      : acca
        ? tn(items.length, "Accumulator · {count} pick", "Accumulator · {count} picks", { count: items.length })
        : tn(items.length, "{count} separate bet", "{count} separate bets", { count: items.length });
  const summaryHint = system
    ? t("A lost pick only loses the bets it's in.")
    : builder || acca
      ? t("Every pick has to win.")
      : t("Each bet wins or loses on its own.");

  let blocker: string | null = null;
  if (info?.blocked) blocker = ts(info.blocked);
  else if (closed.length > 0) blocker = closed.length === 1 ? t("Remove the match that has closed to continue.") : t("Remove the matches that have closed to continue.");
  else if (paused.length > 0) blocker = paused.length === 1 ? t("Live betting is paused on {match}. Wait a moment or remove it.", { match: paused[0].eventName }) : t("Live betting is paused on some of your picks. Wait a moment or remove them.");
  else if (builder && quote?.error) blocker = quote.error;
  else if (builder && !quote) blocker = t("Working out the bet builder's price. One moment.");
  else if (acca && hasSp) blocker = t("Greyhound picks can only be single bets. Switch to Singles or remove them.");
  else if (acca && sameMatch) blocker = t("An accumulator needs each pick from a different match. Remove one of the picks from the same match.");
  else if (acca && accaOdds > MAX_ACCUMULATOR_ODDS) blocker = t("Combined odds can be at most {max}. Remove a pick to continue.", { max: MAX_ACCUMULATOR_ODDS });
  else if (missingStake && system) blocker = t("Enter a stake per bet so the system costs at least 1 ALL.");
  else if (missingStake) blocker = combined ? t("Enter a stake of at least 1 ALL.") : t("Enter a stake of at least 1 ALL on each bet.");
  else if (overMax) blocker = t("The most you can stake on one bet is {amount}.", { amount: formatMoney(info!.maxStake!) });
  else if (tooLittle) blocker = t("Your balance is too low for this slip. Tap here to ask for a top-up.");
  const needsMoney = Boolean(blocker) && !info?.blocked && closed.length === 0 && paused.length === 0 && !(acca && (hasSp || sameMatch || accaOdds > MAX_ACCUMULATOR_ODDS)) && !(builder && !quote?.odds) && !missingStake && !overMax && tooLittle;

  // A moved price shows on the slip itself (the old price struck through); a toast only says so when a bet is refused for it.
  useEffect(() => {
    if (items.length === 0) setTakeNewPrice(false);
  }, [items.length]);

  function setStake(id: string, stake: string) {
    onChange((list) => list.map((item) => (item.selectionId === id ? { ...item, stake } : item)));
  }

  async function place(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (placingRef.current || items.length === 0) return;
    // Why the slip can't go yet pops up when they try, instead of sitting in the slip.
    if (blocker) {
      // Too little money: a tap on the message asks their Manager or Owner for more.
      if (needsMoney) toast.warning(blocker, { onClick: () => void topUp.request(shortfall) });
      else toast.warning(blocker);
      return;
    }
    // Before the first wait, so a second tap meanwhile finds the slip already going and does nothing.
    placingRef.current = true;
    setPlacing(true);
    const token = await getToken();
    if (!token) {
      placingRef.current = false;
      setPlacing(false);
      return;
    }
    // The stake shows as pending under the balance at once; it's taken or given back when the API answers.
    showPending(totalStake);
    if (hasLive) {
      // The countdown runs to when the API should answer: the wait it gives this slip right now, asked as the slip goes.
      const started = Date.now();
      setDeadline(started + (planned?.live ? planned.waitMs : (info?.liveWait?.usual ?? 8) * 1000) + CHECK_TYPICAL_MS);
      void loadPlanned()
        .then((wait) => wait?.live && setDeadline(started + wait.waitMs + CHECK_TYPICAL_MS))
        .catch(() => undefined);
    }
    const body = JSON.stringify({
      ...(system
        ? { system: { legs: items.map((item) => ({ selectionId: item.selectionId, odds: item.odds })), sizes: systemChoice.sizes, lineStake: accaStakeValue } }
        : builder
          ? { builder: { legs: items.map((item) => ({ selectionId: item.selectionId, odds: item.odds })), odds: builderOdds, stake: accaStakeValue } }
          : acca
            ? { accumulator: { legs: items.map((item) => ({ selectionId: item.selectionId, odds: item.odds })), stake: accaStakeValue } }
            : { bets: items.map((item) => ({ selectionId: item.selectionId, stake: stakeValue(item.stake), odds: item.odds })) }),
      // The prices sent are the ones on the slip, new ones included: the Player's setting says what to do if they move again.
      priceChanges,
    });
    try {
      const result = await apiFetch<PlaceBetsResponse>("/bets", token, { method: "POST", body, idempotencyKey: idempotency.keyFor("/bets", body) });
      idempotency.done();
      setReceipt(result);
      // The top bar's balance, now: the live stream that normally brings it may be reconnecting.
      if (typeof result.balance === "number") showBalance(result.balance);
      showPending(null);
      // Every placement says so, with a way to the open bets, whether or not the slip stays open to show the receipt.
      const openBets = () => router.push("/dashboard/bet?tab=open");
      toast.success(
        result.bets.length === 1
          ? result.bets[0].kind === "ACCUMULATOR"
            ? t("Your accumulator is on. {amount} was taken from your balance.", { amount: formatMoney(result.total) })
            : result.bets[0].kind === "SYSTEM"
              ? t("Your system bet is on. {amount} was taken from your balance.", { amount: formatMoney(result.total) })
            : result.bets[0].kind === "BUILDER"
              ? t("Your bet builder is on. {amount} was taken from your balance.", { amount: formatMoney(result.total) })
              : t("Your bet is on. {amount} was taken from your balance.", { amount: formatMoney(result.total) })
          : t("Your {count} bets are on. {amount} was taken from your balance.", { count: result.bets.length, amount: formatMoney(result.total) }),
        { title: t("Bets placed · tap to see your open bets"), onClick: openBets, duration: 8000 },
      );
      if (result.adjusted) toast.info(t("Placed at the latest price."));
      setTakeNewPrice(false);
      onChange(() => []);
      onAccaStake("");
      onMode("singles");
      onPlaced();
    } catch (err) {
      showPending(null);
      const message = err instanceof Error ? err.message : t("Couldn't place your bets");
      const original = err instanceof ApiError ? err.original : message;
      // A big move keeps the slip and asks for the new price. A goal, a pause, or a closed match still stops it.
      if (/odds changed/i.test(original)) {
        toast.info(message);
        setTakeNewPrice(true);
        onOddsChanged();
        if (builder) setRequote((n) => n + 1);
      } else {
        toast.error(message);
        if (/closed|no longer exists|paused|score changed|while your bet|caught up/i.test(original)) {
          onOddsChanged();
          if (builder) setRequote((n) => n + 1);
        }
      }
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  }

  if (receipt && items.length === 0) {
    return (
      <div className="card stack bet-slip is-receipt">
        <div className="bet-slip-header">
          <h2>{t("Bets placed")}<HelpTip text="Your bets went through. The money was taken from your balance. You can follow them in Open bets." /></h2>
          <button type="button" className="secondary bet-slip-close" onClick={onClose} aria-label={t("Close bet slip")}>
            ✕
          </button>
        </div>
        <ul className="bet-receipt">
          {receipt.bets.map((bet) => (
            <li key={bet.id}>
              <span>{ts(bet.description)}</span>
              <span className="muted">{t("Ref {id}", { id: bet.id.slice(-8) })}</span>
              <span className="muted">
                {bet.sp
                  ? t("{stake} at the starting price (SP)", { stake: formatMoney(bet.stake) })
                  : t("{stake} at {odds} · returns {amount}", { stake: formatMoney(bet.stake), odds: bet.odds?.toFixed(2) ?? "–", amount: formatMoney(bet.potentialPayout ?? 0) })}
              </span>
            </li>
          ))}
        </ul>
        <div className="bet-slip-actions">
          <Link href="/dashboard/bet?tab=open" className="button-link" onClick={onClose}>
            {t("See open bets")}
          </Link>
          <button type="button" className="secondary" onClick={() => setReceipt(null)}>
            {t("New slip")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="card stack bet-slip" onSubmit={place}>
      <div className="bet-slip-header">
        <h2>
          {t("Bet slip")} {items.length > 0 ? <span className="muted">({items.length})</span> : null}<HelpTip text="The picks you tapped. Type how much to bet on each, then press Place. “Singles” are separate bets. “Accumulator” joins them into one bet that pays much more but only wins if every pick wins." />
        </h2>
        <span className="bet-slip-header-actions">
          {items.length > 0 ? (
            <button type="button" className="text-button" onClick={() => onChange(() => [])}>
              {t("Clear")}
            </button>
          ) : null}
          <button type="button" className="secondary bet-slip-close" onClick={onClose} aria-label={t("Close bet slip")}>
            ✕
          </button>
        </span>
      </div>

      {items.length === 0 ? (
        <div className="bet-slip-empty">
          <strong>{t("Your slip is empty")}</strong>
          <p className="muted">{t("Tap a price to add a bet.")}</p>
          {info ? <p className="bet-slip-balance">{t("Balance {amount}", { amount: formatMoney(info.balance) })}</p> : null}
        </div>
      ) : (
        <>
          <div className="bet-slip-body">
          {/* Always there, so the Player sees what they can build: the ones that need more picks (or a match that
              hasn't started, for the bet builder) are greyed out, with what to do under them. */}
          <div className="bet-mode" role="group" aria-label={t("Bet type")}>
            <button type="button" className={`bet-mode-option${!combined && !system ? " is-active" : ""}`} aria-pressed={!combined && !system} onClick={() => onMode("singles")}>
              {t("Singles")}
            </button>
            <button type="button" className={`bet-mode-option${combined ? " is-active" : ""}`} aria-pressed={combined} disabled={!canCombine} onClick={() => onMode("accumulator")}>
              {oneMatch ? t("Bet builder") : t("Accumulator")}
            </button>
            {!oneMatch ? (
              <button type="button" className={`bet-mode-option${system ? " is-active" : ""}`} aria-pressed={system} disabled={!systemChoice || systemOptions(items.length).length === 0} onClick={() => onMode("system")}>
                {t("System")}
              </button>
            ) : null}
          </div>
          {modeHint ? <p className="muted bet-mode-hint">{modeHint}</p> : null}
          {system ? (
            <label className="bet-system-pick">
              <span className="muted">{t("System")}</span>
              <select value={systemChoice.sizes.join(",")} onChange={(e) => onSystemKey(e.target.value)}>
                {systemOptions(items.length).map((option) => (
                  <option key={option.sizes.join(",")} value={option.sizes.join(",")}>
                    {option.name
                      ? tn(option.lines, "{name} · {count} bet", "{name} · {count} bets", { name: t(option.name) })
                      : tn(option.lines, "{size} from {picks} · {count} bet", "{size} from {picks} · {count} bets", { size: option.sizes[0], picks: items.length })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="bet-quick" role="group" aria-label={system ? t("Stake per bet") : builder ? t("Bet builder stake") : acca ? t("Accumulator stake") : t("Same stake on every bet")}>
            {QUICK_STAKES.map((amount) => {
              const chosen = combined || system ? accaStakeValue === amount : items.length > 0 && items.every((item) => stakeValue(item.stake) === amount);
              return (
                <button
                  key={amount}
                  type="button"
                  className={`bet-chip${chosen ? " is-active" : ""}`}
                  aria-pressed={chosen}
                  onClick={() => (combined || system ? onAccaStake(String(amount)) : onChange((list) => list.map((item) => ({ ...item, stake: String(amount) }))))}
                >
                  {formatStake(amount)}
                </button>
              );
            })}
          </div>
          <ul className="bet-slip-items">
            {items.map((item) => {
              const stake = stakeValue(item.stake);
              return (
                <li key={item.selectionId} className={`bet-slip-item${item.closed ? " is-closed" : item.paused ? " is-paused" : ""}`}>
                  <div className="bet-slip-item-top">
                    <div className="bet-slip-item-name">
                      <strong>{pickLabel(item.name, i18n)}</strong>
                      <span className="muted">
                        {ts(item.market)} · {item.eventName}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary bet-slip-remove"
                      onClick={() => onChange((list) => list.filter((other) => other.selectionId !== item.selectionId))}
                      aria-label={t("Remove {pick} from the slip", { pick: pickLabel(item.name, i18n) })}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="bet-slip-item-bottom">
                    <span className={`bet-slip-odds${item.previousOdds !== undefined ? " has-moved" : ""}`}>
                      {item.closed ? (
                        <span className="error-text">{t("Closed")}</span>
                      ) : (
                        <>
                          {item.previousOdds !== undefined ? <s className="muted">{item.previousOdds.toFixed(2)}</s> : null}
                          <strong>{item.sp ? "SP" : item.odds.toFixed(2)}</strong>
                          {item.previousOdds !== undefined ? <PriceArrow move={{ up: item.odds > item.previousOdds, until: Infinity }} /> : null}
                        </>
                      )}
                    </span>
                    {builder || system ? null : acca ? (
                      <span className="bet-slip-return muted">{sameMatch && items.some((other) => other !== item && other.eventId === item.eventId) ? t("Same match as another pick") : ""}</span>
                    ) : (
                    <label className="bet-stake">
                      <span className="muted">ALL</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={1}
                        step="0.01"
                        placeholder={t("Stake")}
                        value={item.stake}
                        onChange={(e) => setStake(item.selectionId, e.target.value)}
                        aria-label={t("Stake on {pick}", { pick: pickLabel(item.name, i18n) })}
                        disabled={item.closed}
                      />
                    </label>
                    )}
                    {combined || system ? null : (
                      <span className="bet-slip-return muted">
                        {item.closed || item.paused ? t("Not counted") : item.sp ? t("Paid at the starting price") : stake > 0 ? t("Returns {amount}", { amount: formatMoney(returns(stake, item.odds)) }) : ""}
                      </span>
                    )}
                  </div>
                  {item.closed ? <p className="bet-slip-flag">{t("Remove it to continue.")}</p> : item.paused ? <p className="bet-slip-flag">{t("Paused. Wait a moment or remove it.")}</p> : null}
                </li>
              );
            })}
          </ul>

          {system ? (
            <div className="bet-slip-item bet-acca-stake">
              <div className="bet-slip-item-bottom">
                <span className="bet-slip-odds">
                  <span className="muted">{t("Bets")}</span>
                  <strong>{systemLines}</strong>
                </span>
                <label className="bet-stake">
                  <span className="muted">ALL</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={MIN_SYSTEM_LINE_STAKE}
                    step="0.01"
                    placeholder={t("Per bet")}
                    value={accaStake}
                    onChange={(e) => onAccaStake(e.target.value)}
                    aria-label={t("Stake per bet")}
                  />
                </label>
              </div>
              <p className="muted bet-slip-note" style={{ margin: 0 }}>
                {t("{lines} bets × {stake} = {total}. Each double, treble… is its own small accumulator: a lost pick only loses the bets it's in, and a void pick counts as 1.00.", {
                  lines: systemLines,
                  stake: formatMoney(accaStakeValue),
                  total: formatMoney(totalStake),
                })}
              </p>
              {systemLines > 0 && accaStakeValue > 0 ? (
                <details className="bet-system-breakdown">
                  <summary>{tn(systemLines, "Show the {count} bet", "Show the {count} bets", { count: systemLines })}</summary>
                  <ul>
                    {systemBreakdown(valid.map((item) => item.odds), systemSizes, accaStakeValue).map((line) => (
                      <li key={line.picks.join("-")}>
                        <span>{line.picks.map((i) => pickLabel(valid[i].name, i18n)).join(" + ")}</span>
                        <span className="muted">
                          {line.price.toFixed(2)} → {formatMoney(line.returns)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">{t("Every bet's return is added up exactly, and only the total is rounded down to the cent: {total}.", { total: formatMoney(totalReturn) })}</p>
                </details>
              ) : null}
            </div>
          ) : null}
          {combined ? (
            <div className="bet-slip-item bet-acca-stake">
              <div className="bet-slip-item-bottom">
                <span className="bet-slip-odds">
                  <span className="muted">{builder ? t("Bet builder") : t("Combined")}</span>
                  <strong>{builder ? (quote?.odds ? quote.odds.toFixed(2) : "–") : accaOdds.toFixed(2)}</strong>
                </span>
                <label className="bet-stake">
                  <span className="muted">ALL</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={1}
                    step="0.01"
                    placeholder={t("Stake")}
                    value={accaStake}
                    onChange={(e) => onAccaStake(e.target.value)}
                    aria-label={builder ? t("Bet builder stake") : t("Accumulator stake")}
                  />
                </label>
              </div>
              <p className="muted bet-slip-note" style={{ margin: 0 }}>
                {builder
                  ? quote?.error
                    ? <span className="error-text">{quote.error}</span>
                    : t("Picks from one match, priced together: they often happen together, so this pays less than multiplying them. Every pick has to win. If a pick is void, the bet is refunded.")
                  : t("Every pick has to win. A pick on a match that is called off drops out and the rest still count.")}
              </p>
            </div>
          ) : null}

          </div>
          <div className="bet-slip-dock">
            <div className="bet-slip-summary">
              <div className="bet-slip-summary-lead">
                <strong>{summaryTitle}</strong>
                {blocker && needsMoney ? (
                  <button type="button" className="text-button bet-slip-flag" onClick={() => void topUp.request(shortfall)}>{blocker}</button>
                ) : (
                  <p className={blocker ? "bet-slip-flag" : "muted"}>{blocker ?? summaryHint}</p>
                )}
              </div>
              <dl>
                <div>
                  <dt className="muted">{t("Total stake")}</dt>
                  <dd>{formatMoney(totalStake)}</dd>
                </div>
                <div>
                  <dt className="muted">{t("If they win")}</dt>
                  <dd>
                    <strong>{formatMoney(totalReturn)}</strong>
                    {hasSp && !combined && !system ? <span className="muted"> {t("+ SP bets")}</span> : null}
                  </dd>
                </div>
                {info ? (
                  <div>
                    <dt className="muted">{t("Balance after")}</dt>
                    <dd>{totalStake > 0 ? `${formatMoney(info.balance)} → ${formatMoney(info.balance - totalStake)}` : formatMoney(info.balance)}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
            {movedItems.length > 0 ? (
              <div className="bet-slip-moved" role="status">
                <strong>{tn(movedItems.length, "A price changed. Check it before you place:", "{count} prices changed. Check them before you place:")}</strong>
                <ul>
                  {movedItems.map((item) => (
                    <li key={item.selectionId}>
                      <span>{pickLabel(item.name, i18n)}</span>
                      <span className={item.odds > item.previousOdds! ? "is-up" : "is-down"}>
                        <s>{item.previousOdds!.toFixed(2)}</s> → <strong>{item.odds.toFixed(2)}</strong> {item.odds > item.previousOdds! ? "▲" : "▼"}
                      </span>
                    </li>
                  ))}
                </ul>
                {returnBefore !== null && Math.abs(returnBefore - totalReturn) >= 0.01 ? (
                  <p>{t("If they win: {now} (was {before})", { now: formatMoney(totalReturn), before: formatMoney(returnBefore) })}</p>
                ) : null}
              </div>
            ) : null}
            <button type="submit" className={`bet-place${blocker ? " is-blocked" : ""}`} disabled={placing} aria-disabled={Boolean(blocker)}>
              {placing
                ? hasLive
                  ? <LiveCountdown deadline={deadline} />
                  : <LoadingSpinner label="Placing" size="small" />
                : priceMoved
                  ? t("Place at the new price · {amount}", { amount: formatMoney(totalStake) })
                  : system
                  ? t("Place system bet · {amount}", { amount: formatMoney(totalStake) })
                  : builder
                  ? t("Place bet builder · {amount}", { amount: formatMoney(totalStake) })
                  : acca
                  ? t("Place accumulator · {amount}", { amount: formatMoney(totalStake) })
                  : tn(items.length, "Place bet · {amount}", "Place {count} bets · {amount}", { amount: formatMoney(totalStake) })}
            </button>
            <label className="bet-price-setting">
              <span className="muted">{t("Accept price changes")}</span>
              <select value={priceChanges} onChange={(e) => setPriceChanges(e.target.value === "never" ? "never" : "higher")}>
                <option value="higher">{t("Only higher odds, before kick-off")}</option>
                <option value="never">{t("Never")}</option>
              </select>
            </label>
            {hasLive ? <p className="muted bet-price-setting-note">{t("Live bets are only placed at the price on your slip.")}</p> : null}
            {info ? <SlipLimits info={info} staking={totalStake} /> : null}
            {hasLive ? (
              <p className="muted bet-slip-live-rule">
                {t("Live: a bet placed after a goal, a corner or a card that hadn't shown here yet, and that helped it, is void and the stake comes back, even after it has settled. Live corners bets are capped for each match.")}{" "}
                {t("This slip takes about {seconds} seconds to confirm.", { seconds: liveSeconds ?? (info?.liveWait?.usual ?? 8) + 1 })}
              </p>
            ) : null}
          </div>
        </>
      )}
    </form>
  );
}

/** The Player's limits: the most per bet, and a bar for how much of today's loss limit is used. */
function SlipLimits({ info, staking }: { info: SlipInfo; staking: number }) {
  const { t } = useI18n();
  if (info.maxStake === null && info.dailyLossLimit === null) return null;
  const limit = info.dailyLossLimit;
  const used = limit === null ? 0 : Math.min(info.dailyLossUsed + staking, limit);
  const share = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="bet-limits">
      {info.maxStake !== null ? <p className="muted bet-slip-note">{t("Most you can bet at once: {amount}", { amount: formatMoney(info.maxStake) })}</p> : null}
      {limit !== null ? (
        <div className="bet-limit-meter">
          <div className="bet-limit-meter-label">
            <span className="muted">
              {t("Daily loss limit")}
              <HelpTip text="The most you can lose today. Money you lost today plus money on bets placed today that are not finished counts. It starts again at midnight (UTC)." />
            </span>
            <span>{t(staking > 0 ? "{used} of {limit} with this slip" : "{used} of {limit} used", { used: formatMoney(used), limit: formatMoney(limit) })}</span>
          </div>
          <div className={`bet-limit-bar${share >= 100 ? " is-full" : share >= 75 ? " is-high" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={t("Daily loss limit")}>
            <span style={{ width: `${share}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<Bet["status"], string> = { OPEN: msg("Open"), WON: msg("Won"), LOST: msg("Lost"), VOID: msg("Refunded") };
const STATUS_ICON: Record<Bet["status"], string> = { OPEN: "⏳", WON: "✓", LOST: "✗", VOID: "↺" };

function StatusPill({ status }: { status: Bet["status"] }) {
  const { t } = useI18n();
  return (
    <span className={`status-pill bet-status-${status.toLowerCase()}`}>
      <span aria-hidden="true">{STATUS_ICON[status]}</span> {t(STATUS_LABEL[status])}
    </span>
  );
}

/** What a finished bet did to the balance, in big green or red: +15.00 ALL, −10.00 ALL, or the stake back. */
function BetResult({ bet }: { bet: Bet }) {
  const { t } = useI18n();
  if (bet.status === "OPEN") return null;
  const net = Math.round((bet.payout - bet.stake) * 100) / 100;
  if (bet.status === "VOID") return <p className="bet-result is-void">{t("Your {amount} came back to your balance", { amount: formatMoney(bet.stake) })}</p>;
  return net >= 0 ? (
    <p className="bet-result is-won">{t("You won {amount}", { amount: `+${formatMoney(net)}` })}</p>
  ) : (
    <p className="bet-result is-lost">{t("You lost {amount}", { amount: `−${formatMoney(-net)}` })}</p>
  );
}

/** Why a bet was cancelled. The reason is what the team typed, so it may be in any language. */
function voidText(reason: string | null, ts: I18n["ts"], t: I18n["t"]) {
  return reason ? ` · ${t("Cancelled: {reason}", { reason: ts(reason) })}` : "";
}

/** Each tab's last list of bets this visit, shown at once when the tab opens again while it's fetched afresh. */
const betsSeen = new Map<string, MyBets>();
/** Bets on a page: a short first page shows sooner; "Show more" brings the next. */
const BETS_PAGE = 20;

function MyBetsList({ status, version }: { status: "open" | "settled"; version: number }) {
  const { getToken, userId } = useAuth();
  const { t, tn } = useI18n();
  const seenKey = `${userId ?? ""}:${status}`;
  const [data, setData] = useState<MyBets | null>(() => betsSeen.get(seenKey) ?? null);
  const [more, setMore] = useState<Bet[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      if (!token) return;
      const next = await apiFetch<MyBets>(`/bets/mine?status=${status}&limit=${BETS_PAGE}`, token);
      if (cancelled) return;
      betsSeen.set(seenKey, next);
      setData(next);
      setMore([]);
      setHasMore(next.hasMore);
    })().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Couldn't load your bets"));
    });
    return () => {
      cancelled = true;
    };
  }, [getToken, status, version, toast, t, seenKey]);

  // While a match on an open bet is live, its score and match updates refresh every 20 seconds.
  const loaded = [...(data?.bets ?? []), ...more];
  const watching = status === "open" && loaded.some((bet) => bet.event?.status === "LIVE" || bet.legs.some((leg) => leg.event.status === "LIVE"));
  usePolling(
    () =>
      void (async () => {
        const token = await getToken();
        if (!token) return;
        const next = await apiFetch<MyBets>(`/bets/mine?status=${status}&limit=${BETS_PAGE}`, token);
        betsSeen.set(seenKey, next);
        setData(next);
        // Bets loaded with "Show more" get their fresh copy too, where the first page has one.
        const fresh = new Map(next.bets.map((bet) => [bet.id, bet]));
        setMore((list) => list.map((bet) => fresh.get(bet.id) ?? bet));
      })().catch(() => undefined),
    20_000,
    watching,
  );

  async function loadMore() {
    const all = [...(data?.bets ?? []), ...more];
    const last = all[all.length - 1];
    if (!last) return;
    const token = await getToken();
    if (!token) return;
    setLoadingMore(true);
    try {
      const before = status === "open" ? last.placedAt : last.settledAt ?? last.placedAt;
      const next = await apiFetch<MyBets>(`/bets/mine?status=${status}&limit=${BETS_PAGE}&before=${encodeURIComponent(before)}`, token);
      setMore((list) => [...list, ...next.bets]);
      setHasMore(next.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't load more bets"));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!data) {
    if (failed) return null;
    // Rows shaped like bets while the first page loads.
    return <ListSkeleton label="Loading your bets" groups={1} rows={4} />;
  }
  const bets = [...data.bets, ...more];

  return (
    <div className="stack">
      {status === "open" && data.open.count > 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {tn(data.open.count, "{count} open bet · {amount} staked", "{count} open bets · {amount} staked", { amount: formatMoney(data.open.staked) })}
        </p>
      ) : null}
      {bets.length === 0 ? (
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>
            {status === "open" ? t("You have no open bets.") : t("No settled bets yet. Results appear here once a match finishes.")}
          </p>
          {status === "open" ? (
            <Link href="/dashboard/bet" className="button-link" style={{ justifySelf: "start" }}>
              {t("Browse matches")}
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="bet-list">
          {bets.map((bet) => (
            <BetCard key={bet.id} bet={bet} />
          ))}
        </ul>
      )}
      {hasMore ? (
        <button type="button" className="secondary" onClick={loadMore} disabled={loadingMore} style={{ justifySelf: "center" }}>
          {loadingMore ? <LoadingSpinner label="Loading more bets" size="small" /> : t("Show more")}
        </button>
      ) : null}
    </div>
  );
}

/** A system bet's name: "Yankee", "2 from 4", or "2/3 from 5". */
function systemLabel(system: NonNullable<Bet["system"]>, picks: number, t: I18n["t"]): string {
  return /from/.test(system.name) ? t("{sizes} from {picks}", { sizes: system.sizes.join("/"), picks }) : t(system.name);
}

function AccumulatorCard({ bet }: { bet: Bet }) {
  const { t, tn, ts, date } = useI18n();
  const decided = bet.legs.filter((leg) => leg.result !== null).length;
  const when =
    bet.status === "OPEN"
      ? t("{done} of {total} picks settled", { done: decided, total: bet.legs.length })
      : bet.settledAt
        ? t("Settled {when}", { when: date(bet.settledAt, DATE_TIME) })
        : "";
  return (
    <li className={`card bet-card is-${bet.status.toLowerCase()}`}>
      <div className="bet-card-top">
        <div className="bet-card-name">
          <strong>{bet.system ? systemLabel(bet.system, bet.legs.length, t) : bet.kind === "BUILDER" ? t("Bet builder") : t("Accumulator")}</strong>
          <span className="muted">
            {t("Ref {id}", { id: bet.id.slice(-8) })}
            {" · "}
            {tn(bet.legs.length, "{count} pick", "{count} picks")}
            {bet.system ? ` · ${tn(bet.system.lines, "{count} bet of {stake}", "{count} bets of {stake}", { stake: formatMoney(bet.system.lineStake) })}` : ""}
          </span>
        </div>
        <StatusPill status={bet.status} />
      </div>
      <BetLegs legs={bet.legs} />
      <dl className="bet-card-numbers">
        <div>
          <dt className="muted">{t("Stake")}</dt>
          <dd>{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="muted">{bet.system ? t("Stake per bet") : t("Odds")}</dt>
          <dd>{bet.system ? formatMoney(bet.system.lineStake) : bet.odds?.toFixed(2) ?? "–"}</dd>
        </div>
        <div>
          <dt className="muted">{bet.status === "OPEN" ? t("To return") : t("Returned")}</dt>
          <dd>
            <strong>{formatMoney(bet.status === "OPEN" ? bet.potentialPayout ?? 0 : bet.payout)}</strong>
          </dd>
        </div>
      </dl>
      <BetResult bet={bet} />
      <p className="muted bet-card-when">
        {when}
        {voidText(bet.voidReason, ts, t)}
      </p>
    </li>
  );
}

function BetCard({ bet }: { bet: Bet }) {
  const i18n = useI18n();
  const { t, ts, date } = i18n;
  if (bet.kind !== "SINGLE") return <AccumulatorCard bet={bet} />;
  const event = bet.event;
  const score = event?.result ?? (event && event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING" ? { home: event.homeScore, away: event.awayScore } : null);
  let when = "";
  if (event && bet.status === "OPEN") {
    if (event.status === "LIVE") when = t("Live now");
    else if (event.status === "POSTPONED") when = t("Postponed");
    else if (event.status === "COMPLETED") when = t("Finished, settling soon");
    else if (bet.sp && new Date(event.startsAt).getTime() < Date.now()) when = t("Race run, waiting for the official result");
    else when = t("Starts {when}", { when: date(event.startsAt, DATE_TIME) });
  }
  return (
    <li className={`card bet-card is-${bet.status.toLowerCase()}`}>
      <div className="bet-card-top">
        <div className="bet-card-name">
          <strong>{bet.selection ? pickLabel(bet.selection.name, i18n) : ts(bet.description)}</strong>
          <span className="muted">{t("Ref {id}", { id: bet.id.slice(-8) })}{bet.selection ? ` · ${ts(bet.selection.market)}` : ""}</span>
        </div>
        <StatusPill status={bet.status} />
      </div>
      {event ? (
        <div className="bet-card-event">
          <span>{event.name}</span>
          {score ? <strong className="odds-score">{score.home} – {score.away}</strong> : null}
        </div>
      ) : null}
      {event && bet.status === "OPEN" ? <MatchCentre event={event} /> : null}
      <dl className="bet-card-numbers">
        <div>
          <dt className="muted">{t("Stake")}</dt>
          <dd>{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="muted">{t("Odds")}</dt>
          <dd>{bet.odds?.toFixed(2) ?? (bet.sp ? "SP" : "–")}</dd>
        </div>
        <div>
          <dt className="muted">{bet.status === "OPEN" ? t("To return") : t("Returned")}</dt>
          <dd>
            {bet.status === "OPEN" && bet.sp ? (
              <span className="muted">{t("At SP, up to {amount}", { amount: formatMoney(Math.floor(bet.stake * (bet.spCap ?? 0) * 100) / 100) })}</span>
            ) : (
              <strong>{formatMoney(bet.status === "OPEN" ? bet.potentialPayout ?? 0 : bet.payout)}</strong>
            )}
          </dd>
        </div>
      </dl>
      <BetResult bet={bet} />
      <p className="muted bet-card-when">
        {bet.status === "OPEN" ? when : bet.settledAt ? t("Settled {when}", { when: date(bet.settledAt, DATE_TIME) }) : ""}
        {voidText(bet.voidReason, ts, t)}
        {bet.status === "VOID" && !bet.voidReason ? ` · ${bet.sp ? t("Dog withdrawn or race called off, stake refunded") : t("Match called off, stake refunded")}` : ""}
      </p>
    </li>
  );
}
