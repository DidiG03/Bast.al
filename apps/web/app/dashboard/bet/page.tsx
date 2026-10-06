"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BetLegs } from "../../../components/bet-legs";
import { GreyhoundRaces } from "../../../components/greyhound-races";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { MarketPriceHistory } from "../../../components/price-history";
import { useRealtime } from "../../../components/realtime-provider";
import { ApiError, apiFetch, type Bet, type MyBets, type OddsEvent, type OddsSelection, type PlaceBetsResponse, type SelectionQuote, type SlipInfo, type Sport } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";
import { useTopUpRequest } from "../../../components/top-up-request";
import { breakPause, livePill } from "../../../lib/live";
import { usePolling } from "../../../lib/use-polling";
import { pickLabel } from "../../../lib/picks";
import { isDaysFromToday } from "../../../lib/time";

type Tab = "matches" | "open" | "settled";
type SlipMode = "singles" | "accumulator";

type SlipItem = {
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

/** Each account's slip is kept apart, so a Player on a shared phone never sees another one's picks. */
const slipStorage = (userId: string) => `bastal-bet-slip:${userId}`;
/** How long a price shows its up or down arrow after it moves. */
const MOVE_SHOWN_MS = 15_000;

type PriceMove = { up: boolean; until: number };
const QUICK_STAKES = [5, 10, 20, 50];
const MAX_SLIP = 10;
/** Matches the API's cap on an accumulator's combined odds. */
const MAX_ACCUMULATOR_ODDS = 5000;
/** Matches drawn at first; "Show more matches" adds this many again, so a week of football doesn't slow a phone down. */
const MATCHES_SHOWN = 60;

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const DATE_TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

function dayLabel(iso: string, { t, date: format }: I18n): string {
  if (isDaysFromToday(iso, 0)) return t("Today");
  if (isDaysFromToday(iso, 1)) return t("Tomorrow");
  const date = new Date(iso);
  // Albanian day names are lower case ("e premte"); as a heading it starts with a capital.
  const label = format(date, { weekday: "long", day: "numeric", month: "short" });
  return label.charAt(0).toUpperCase() + label.slice(1);
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

function readSlip(userId: string): SlipItem[] {
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

function saveSlip(userId: string, items: SlipItem[]) {
  try {
    window.localStorage.setItem(slipStorage(userId), JSON.stringify(items));
  } catch {
    // The slip still works for this visit.
  }
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
  const sport: Sport = sportParam === "greyhounds" || sportParam === "mma" || sportParam === "basketball" || sportParam === "nfl" || sportParam === "tennis" ? sportParam : "football";
  /** Football and MMA share the match list; greyhound races have their own. */
  const listed = sport !== "greyhounds";
  // Opened from a match on the Overview: scroll to it and light it up.
  const matchParam = params.get("match");
  const [focused, setFocused] = useState<string | null>(null);

  const [events, setEvents] = useState<OddsEvent[] | null>(null);
  const [info, setInfo] = useState<SlipInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  const [slip, setSlip] = useState<SlipItem[]>([]);
  const [slipLoaded, setSlipLoaded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mode, setMode] = useState<SlipMode>("singles");
  const [accaStake, setAccaStake] = useState("");
  const [league, setLeague] = useState("");
  const [search, setSearch] = useState("");
  /** "" = every day, "live" = playing now, otherwise a day's label (Today, Tomorrow, …). */
  const [day, setDay] = useState("");
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
      const [live, upcoming] = await Promise.all([sport !== "football" ? [] : list("live"), only === "live" && lists.current.upcoming ? lists.current.upcoming : list("upcoming")]);
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

  const loadDetail = useCallback(
    async (id: string) => {
      const token = await getToken();
      if (!token) return;
      const full = await apiFetch<OddsEvent>(`/odds/events/${id}`, token, { revalidate: true });
      setDetails((current) => (current[id] === full ? current : { ...current, [id]: full }));
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
    setSlip((items) =>
      items.map((item) => {
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
  }, [getToken]);

  /** Everything on the page again: the list (or only its live matches), every opened match, and the slip's prices. */
  const refreshAll = useCallback(
    async (only?: "live") => {
      await Promise.all([loadEvents(only), ...Array.from(expandedRef.current, (id) => loadDetail(id).catch(() => undefined)), refreshSlip().catch(() => undefined)]);
    },
    [loadEvents, loadDetail, refreshSlip],
  );

  function toggleExpanded(id: string) {
    const opening = !expanded.has(id);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening && !details[id]) void loadDetail(id).catch(() => toast.error(t("Couldn't load the matches")));
  }

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
    if (slipLoaded && userId) saveSlip(userId, slip);
    slipRef.current = slip;
  }, [slip, slipLoaded, userId]);

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

  useEffect(() => {
    if (tab !== "matches" || !listed) return;
    loadEvents().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Couldn't load the matches"));
    });
  }, [tab, listed, loadEvents, toast, t]);

  // Prices move and matches kick off: everything every minute, and the live
  // matches every 10 seconds while there are any. Not while the page is out of sight.
  usePolling(() => void refreshAll().catch(() => undefined), 60_000, tab === "matches" && listed);
  usePolling(() => void refreshAll("live").catch(() => undefined), 10_000, tab === "matches" && listed && hasLive);
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

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "bets.changed" || event.type === "resync") {
      void loadInfo().catch(() => undefined);
      setBetsVersion((v) => v + 1);
    }
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

  function toggle(event: OddsEvent, marketName: string, selection: OddsSelection) {
    if (!slip.some((item) => item.selectionId === selection.id) && slip.length >= MAX_SLIP) {
      toast.error(t("A slip holds up to {max} bets.", { max: MAX_SLIP }));
      return;
    }
    setSlip((items) => {
      if (items.some((item) => item.selectionId === selection.id)) return items.filter((item) => item.selectionId !== selection.id);
      if (items.length >= MAX_SLIP) return items;
      const lastStake = items[items.length - 1]?.stake ?? "";
      return [
        ...items,
        { selectionId: selection.id, eventId: event.id, eventName: event.name, startsAt: event.startsAt, market: marketName, name: selection.name, odds: selection.price, stake: lastStake, live: event.live, sp: selection.sp },
      ];
    });
  }

  const leagues = useMemo(() => Array.from(new Set((events ?? []).map((e) => e.league))).sort(), [events]);
  const query = search.trim().toLowerCase();
  const shown = merged.filter(
    (event) => (finishedNow(event) || ((event.bettable || event.live) && event.markets.length > 0)) && (!league || event.league === league) && (!query || event.name.toLowerCase().includes(query) || event.league.toLowerCase().includes(query)),
  );
  const allGroups: Array<[string, OddsEvent[]]> = [];
  const liveLabel = t("Live now");
  for (const event of shown) {
    const label = event.live || finishedNow(event) ? liveLabel : dayLabel(event.startsAt, i18n);
    const last = allGroups[allGroups.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else allGroups.push([label, [event]]);
  }
  // A day that no longer has matches (a search, a league filter) falls back to every day.
  const dayShown = day === "" ? "" : day === "live" ? liveLabel : day;
  const groups = dayShown && allGroups.some(([label]) => label === dayShown) ? allGroups.filter(([label]) => label === dayShown) : allGroups;
  const selected = new Set(slip.map((item) => item.selectionId));
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
      onChange={setSlip}
      onPlaced={() => {
        setBetsVersion((v) => v + 1);
        void loadInfo().catch(() => undefined);
      }}
      onOddsChanged={() => void refreshAll().catch(() => undefined)}
      onClose={() => setSheetOpen(false)}
    />
  );
  const totalStake = mode === "accumulator" && slip.length >= 2 ? stakeValue(accaStake) : slip.reduce((sum, item) => sum + stakeValue(item.stake), 0);

  // The first time, only the spinner shows until the account and the matches have loaded.
  if (!info || (tab === "matches" && listed && events === null && sport === "football")) return failed ? null : <PageLoading label="Loading matches" />;

  return (
    <div className="stack bet-page">
      {/* The balance is already in the top bar, so the header stays one line. */}
      <div className="bet-page-head">
        <h1>
          {t("Bet")}
          <HelpTip text="The matches for this day. Tap a price to add it to your bet slip. A higher number pays more but is less likely to win. Example: $10 at 2.50 pays back $25 if it wins." />
        </h1>
      </div>

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

      {tab === "matches" ? (
        <div className="sport-switch" role="group" aria-label={t("Sport")}>
          {(
            [
              ["football", t("Football")],
              ["greyhounds", t("Greyhounds")],
              ["tennis", t("Tennis")],
              ["basketball", t("Basketball")],
              ["nfl", t("NFL")],
              ["mma", t("MMA")],
            ] as Array<[Sport, string]>
          ).map(([key, label]) => (
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
      ) : null}

      {tab === "matches" && sport === "greyhounds" ? (
        <div className="bet-layout">
          <div className="stack bet-matches">
            <GreyhoundRaces selected={selected} onPick={toggle} active />
          </div>
          <aside className="bet-slip-desktop" aria-label={t("Bet slip")}>
            {slipPanel}
          </aside>
        </div>
      ) : tab === "matches" ? (
        <div className="bet-layout">
          <div className="stack bet-matches">
            <div className="bet-filters">
              <input type="search" placeholder={t("Search teams or leagues")} value={search} onChange={(e) => filter(() => setSearch(e.target.value))} aria-label={t("Search matches")} />
              {allGroups.length > 1 ? (
                <div className="bet-chips bet-day-chips" role="group" aria-label={t("Day")}>
                  <button type="button" className={`bet-chip${groups === allGroups ? " is-active" : ""}`} onClick={() => filter(() => setDay(""))} aria-pressed={groups === allGroups}>
                    {t("All")}
                  </button>
                  {allGroups.map(([label, list]) => {
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
              {leagues.length > 1 ? (
                <div className="bet-chips" role="group" aria-label={t("League")}>
                  <button type="button" className={`bet-chip${league === "" ? " is-active" : ""}`} onClick={() => filter(() => setLeague(""))}>
                    {t("All")}
                  </button>
                  {leagues.map((name) => (
                    <button key={name} type="button" className={`bet-chip${league === name ? " is-active" : ""}`} onClick={() => filter(() => setLeague(league === name ? "" : name))}>
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {events === null ? (
              <div className="loading-state">
                <LoadingSpinner label="Loading matches" />
              </div>
            ) : shown.length === 0 ? (
              <div className="card">
                <p className="muted" style={{ margin: 0 }}>
                  {events.length === 0
                    ? sport === "mma"
                      ? t("No fights are open for bets right now. Check back soon.")
                      : sport === "basketball"
                      ? t("No basketball games are open for bets right now. Check back soon.")
                      : sport === "nfl"
                      ? t("No NFL games are open for bets right now. Check back soon.")
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
                    {dayEvents.map((event) => (
                      <MatchCard
                        key={event.id}
                        event={event}
                        selected={selected}
                        onPick={toggle}
                        focused={focused === event.id}
                        moves={moves}
                        expanded={expanded.has(event.id)}
                        loading={expanded.has(event.id) && !details[event.id]}
                        onToggle={() => toggleExpanded(event.id)}
                      />
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
          <aside className="bet-slip-desktop" aria-label={t("Bet slip")}>
            {slipPanel}
          </aside>
        </div>
      ) : (
        <MyBetsList status={tab} version={betsVersion} />
      )}

      {slip.length > 0 && tab === "matches" ? (
        <button type="button" className="bet-slip-bar" onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
          <span className="bet-slip-count">{slip.length}</span>
          <span>{t("Bet slip")}</span>
          <span className="bet-slip-bar-total">{totalStake > 0 ? formatMoney(totalStake) : t("Add stakes")}</span>
        </button>
      ) : null}

      {sheetOpen ? (
        <div className="bet-sheet-layer" role="dialog" aria-modal="true" aria-label={t("Bet slip")}>
          <button type="button" className="bet-sheet-backdrop" aria-label={t("Close bet slip")} onClick={() => setSheetOpen(false)} />
          <div className="bet-sheet">{slipPanel}</div>
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
  // Tennis: who wins the match, then the sets (the 1st set and the score in sets), then games.
  if (key === "tn_winner" || key.startsWith("tn_straight_")) return "main";
  if (/^tn_(games|handicap)_/.test(key)) return "games";
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

/** Players shown in a goalscorer market before "Show all players". */
const SCORERS_SHOWN = 12;

function MatchCard({
  event,
  selected,
  onPick,
  focused,
  moves,
  expanded,
  loading,
  onToggle,
}: {
  event: OddsEvent;
  selected: Set<string>;
  onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void;
  focused: boolean;
  moves: Map<string, PriceMove>;
  /** Every market showing (they load when the match is opened). */
  expanded: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  /** Goalscorer markets showing every player. */
  const [allPlayers, setAllPlayers] = useState<Set<string>>(new Set());
  const over = finishedNow(event);
  // A finished match shows its final score and no prices.
  const markets = over ? [] : expanded ? event.markets : event.markets.slice(0, 1);
  const more = over ? 0 : Math.max(0, event.marketCount - 1);
  const grouped = MARKET_GROUPS.map(([id, label]) => [label, markets.filter((market) => marketGroup(market.key) === id)] as const).filter(([, list]) => list.length > 0);
  const toggleLabel = expanded ? t("Fewer markets") : tn(more, "{count} more market", "{count} more markets");
  return (
    <article id={`match-${event.id}`} className={`card odds-event bet-match${event.live ? " is-live" : ""}${focused ? " is-focused" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league}
          {event.country ? ` · ${event.country}` : ""}
        </span>
        <span className="odds-event-header-side">
          {over ? (
            <span className="status-pill">{livePill(event, t)}</span>
          ) : event.live ? (
            <span className="status-pill is-active">
              <span className="live-dot" aria-hidden="true" />
              {livePill(event, t)}
            </span>
          ) : (
            <span className="status-pill">{date(event.startsAt, TIME)}</span>
          )}
          {/* Opens or closes the other markets from the top, so there's no scrolling down to close them. */}
          {more > 0 ? (
            <button type="button" className={`markets-toggle${expanded ? " is-open" : ""}`} onClick={onToggle} aria-expanded={expanded} aria-label={toggleLabel}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          ) : null}
        </span>
      </header>
      <div className="odds-teams">
        <span className="odds-team">
          <span className="team-badge" aria-hidden="true">{(event.homeTeam ?? event.name).slice(0, 1)}</span>
          {event.homeTeam ?? event.name}
        </span>
        {(event.live || over) && event.homeScore !== null && event.awayScore !== null ? (
          <strong className="odds-score">
            {event.homeScore} – {event.awayScore}
          </strong>
        ) : (
          <span className="odds-vs">{t("vs")}</span>
        )}
        <span className="odds-team">
          {event.awayTeam ?? ""}
          <span className="team-badge" aria-hidden="true">{(event.awayTeam ?? "?").slice(0, 1)}</span>
        </span>
      </div>
      {over ? (
        <p className="bet-paused is-finished">{t(breakPause(event) ?? "")}</p>
      ) : event.live && !event.bettable ? (
        <p className={`bet-paused${event.livePause === "goal" ? " is-goal" : ""}`}>
          {/* A goal or the last minutes say so; otherwise a break in play explains the pause better than "a moment". */}
          {t(event.livePause === "goal" || event.livePause === "late" ? PAUSE_TEXT[event.livePause] : breakPause(event) ?? PAUSE_TEXT[event.livePause ?? "feed"] ?? PAUSE_TEXT.feed)}
        </p>
      ) : null}
      {grouped.map(([label, list]) => (
        <div key={label} className="odds-market-group">
          {expanded && grouped.length > 1 ? <h3 className="odds-market-group-title">{t(label)}</h3> : null}
          {list.map((market) => {
            // A market with many outcomes (correct score, goalscorers) hides the ones off the board, unless they're on the slip.
            const offered = market.selections.filter((selection) => !(selection.suspended && !market.suspended && market.selections.length > 3 && !selected.has(selection.id)));
            const scorers = market.key.startsWith("scorer_");
            const showAll = !scorers || allPlayers.has(market.id) || offered.length <= SCORERS_SHOWN + 2;
            const visible = showAll ? offered : offered.filter((selection, index) => index < SCORERS_SHOWN || selected.has(selection.id));
            return (
              <div key={market.id} className="odds-market">
                <div className="odds-market-head">
                  <span className="odds-market-name">
                    {ts(market.name)}
                    {market.suspended ? <span className="muted"> · {t("Suspended")}</span> : null}
                  </span>
                  {/* A goalscorer list is too long for the chart. */}
                  {scorers ? null : <MarketPriceHistory selections={market.selections} compact />}
                </div>
                <div className={`odds-selections${scorers ? " is-players" : ""}`}>
                  {visible.map((selection) => {
                    const isSelected = selected.has(selection.id);
                    const locked = !event.bettable || Boolean(market.suspended || selection.suspended);
                    return (
                      <button
                        key={selection.id}
                        type="button"
                        className={`odds-selection bet-pick${isSelected ? " is-selected" : ""}`}
                        onClick={() => onPick(event, market.name, selection)}
                        aria-pressed={isSelected}
                        disabled={locked && !isSelected}
                        aria-label={t(locked ? "{pick} at {odds}, {market}, {match}, suspended" : "{pick} at {odds}, {market}, {match}", { pick: pickLabel(selection.name, i18n), odds: selection.price.toFixed(2), market: ts(market.name), match: event.name })}
                      >
                        <span className="odds-selection-name">{pickLabel(selection.name, i18n)}</span>
                        <strong className="odds-price">
                          {locked ? "–" : selection.price.toFixed(2)}
                          {locked ? null : <PriceArrow move={moves.get(selection.id)} />}
                        </strong>
                      </button>
                    );
                  })}
                </div>
                {!showAll ? (
                  <button type="button" className="text-button bet-all-players" onClick={() => setAllPlayers((current) => new Set(current).add(market.id))}>
                    {tn(offered.length, "Show all {count} players", "Show all {count} players")}
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
              </div>
            );
          })}
        </div>
      ))}
      {expanded && loading ? (
        <div className="loading-state bet-markets-loading">
          <LoadingSpinner label="Loading markets" />
        </div>
      ) : null}
      {more > 0 ? (
        <footer className="odds-event-footer">
          <button type="button" className={`bet-more-markets${expanded ? " is-open" : ""}`} onClick={onToggle} aria-expanded={expanded}>
            {toggleLabel}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </footer>
      ) : null}
    </article>
  );
}

/** Just finished: the live list keeps it a few minutes, marked full time, instead of dropping it. */
function finishedNow(event: OddsEvent): boolean {
  return event.status === "COMPLETED" || (event.live && event.period === "FT");
}

/** Why a live match isn't taking bets, in words a Player understands. */
const PAUSE_TEXT: Record<string, string> = {
  goal: msg("⚽ Goal! Live betting reopens in a moment, once the prices catch up."),
  swing: msg("Something big just happened in this match. Live betting reopens in a moment."),
  reopen: msg("Live betting is reopening. One moment."),
  late: msg("Live betting has closed for the last minutes of this match."),
  feed: msg("Live betting is paused for a moment."),
};

/** Each sport's icon, drawn in the text's colour: an outline with a soft fill, so it reads on the dark tabs and the bright one alike. */
function SportIcon({ sport }: { sport: Sport }) {
  if (sport === "football")
    // A football: the centre panel and the five around the edge filled in.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <path d="M12 8.4 15.4 10.9 14.1 14.9H9.9L8.6 10.9Z M12.0 5.6 L15.9 3.3 L8.1 3.3Z M18.1 10.0 L21.4 13.0 L19.1 5.6Z M15.8 17.2 L14.0 21.3 L20.2 16.8Z M8.2 17.2 L3.8 16.8 L10.0 21.3Z M5.9 10.0 L4.9 5.6 L2.6 13.0Z" fill="currentColor" />
        <path d="M12 8.4V5.6M15.4 10.9l2.7-.9M14.1 14.9l1.7 2.3M9.9 14.9l-1.7 2.3M8.6 10.9l-2.7-.9" />
        <circle cx="12" cy="12" r="9.5" />
      </svg>
    );
  if (sport === "greyhounds")
    // A greyhound at full stretch, facing right: body and head filled, legs and tail drawn.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6.5 10.2C8.5 8.6 12.5 8.4 15.6 9.4L18.6 6.6C19.2 6 20.2 5.9 20.8 6.4L23 8L22.6 8.8L20.2 8.9C19.3 9.4 18.6 10.6 18 12C17.4 13.4 16.2 13.9 14.8 13.6C12.8 13.1 11.4 12.3 10 12.5C8.6 12.7 7.4 13.2 6.6 13C5.6 12.6 5.6 11 6.5 10.2Z"
          fill="currentColor"
        />
        <path d="M16 13.2 19.2 15.2 22.6 15.6M15 13.5l2.4 2.9 3.2 1.2M7.6 12.6l-3 3.2-3 .4M8.8 12.8 6.6 17l-3 1.2M6.6 10.6c-2-.4-3.6.2-5.2 1.8M19.2 6.6l-1-1.2 1.6.5" />
      </svg>
    );
  if (sport === "basketball")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <circle cx="12" cy="12" r="9.5" />
        <path d="M2.5 12h19M12 2.5v19M5.3 5.3C7.4 7.2 8.6 9.5 8.6 12s-1.2 4.8-3.3 6.7M18.7 5.3c-2.1 1.9-3.3 4.2-3.3 6.7s1.2 4.8 3.3 6.7" />
      </svg>
    );
  if (sport === "nfl")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="12" rx="10" ry="5.8" transform="rotate(-45 12 12)" fill="currentColor" fillOpacity="0.16" />
        <ellipse cx="12" cy="12" rx="10" ry="5.8" transform="rotate(-45 12 12)" />
        {/* The laces along the seam, and a stripe near each end. */}
        <path d="M9.2 14.8 14.8 9.2M9.6 12.6l1.8 1.8M11.1 11.1l1.8 1.8M12.6 9.6l1.8 1.8M5.4 14.2l4.4 4.4M14.2 5.4l4.4 4.4" />
      </svg>
    );
  if (sport === "tennis")
    // A tennis ball: its two curved seams.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <circle cx="12" cy="12" r="9.5" />
        <path d="M5.2 5.4C8.6 8.6 8.6 15.4 5.2 18.6M18.8 5.4c-3.4 3.2-3.4 10 0 13.2" />
      </svg>
    );
  // MMA: a fighter's glove, open at the fingers, with its wrist strap.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 11V7.6A3.6 3.6 0 0 1 10.1 4h3.6a4.8 4.8 0 0 1 4.8 4.8v4.6a5 5 0 0 1-5 5h-2.4a4.6 4.6 0 0 1-4.6-4.6z" fill="currentColor" fillOpacity="0.16" />
      <path d="M6.5 11V7.6A3.6 3.6 0 0 1 10.1 4h3.6a4.8 4.8 0 0 1 4.8 4.8v4.6a5 5 0 0 1-5 5h-2.4a4.6 4.6 0 0 1-4.6-4.6z" />
      <path d="M6.5 11.4h3.6a2.1 2.1 0 0 0 0-4.2H8.4M10.5 4v3.2M14 4.2v3M17.6 6.4 18.5 9" />
      <path d="M8.6 18v2.6h7v-2.8" />
    </svg>
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
  const toast = useToast();
  const [receipt, setReceipt] = useState<PlaceBetsResponse | null>(null);

  const acca = mode === "accumulator";
  const hasSp = items.some((item) => item.sp);
  const accaOdds = combinedOdds(items.map((item) => item.odds));
  const accaStakeValue = stakeValue(accaStake);
  const sameMatch = new Set(items.map((item) => item.eventId)).size < items.length;

  const totalStake = acca ? accaStakeValue : items.reduce((sum, item) => sum + stakeValue(item.stake), 0);
  // Race picks pay the starting price, so they add nothing known to the return.
  const totalReturn = acca ? returns(accaStakeValue, accaOdds) : items.reduce((sum, item) => sum + (item.sp ? 0 : returns(stakeValue(item.stake), item.odds)), 0);
  const missingStake = acca ? accaStakeValue < 1 : items.some((item) => stakeValue(item.stake) < 1);
  const closed = items.filter((item) => item.closed);
  const paused = items.filter((item) => item.paused && !item.closed);
  const hasLive = items.some((item) => item.live);
  const overMax = info?.maxStake != null ? (acca ? accaStakeValue > info.maxStake : items.some((item) => stakeValue(item.stake) > info.maxStake!)) : false;
  const tooLittle = info ? totalStake > info.balance : false;
  const moved = items.some((item) => item.previousOdds !== undefined);

  let blocker: string | null = null;
  if (info?.blocked) blocker = ts(info.blocked);
  else if (closed.length > 0) blocker = closed.length === 1 ? t("Remove the match that has closed to continue.") : t("Remove the matches that have closed to continue.");
  else if (paused.length > 0) blocker = paused.length === 1 ? t("Live betting is paused on {match}. Wait a moment or remove it.", { match: paused[0].eventName }) : t("Live betting is paused on some of your picks. Wait a moment or remove them.");
  else if (acca && hasSp) blocker = t("Greyhound picks can only be single bets. Switch to Singles or remove them.");
  else if (acca && sameMatch) blocker = t("An accumulator needs each pick from a different match. Remove one of the picks from the same match.");
  else if (acca && accaOdds > MAX_ACCUMULATOR_ODDS) blocker = t("Combined odds can be at most {max}. Remove a pick to continue.", { max: MAX_ACCUMULATOR_ODDS });
  else if (missingStake) blocker = acca ? t("Enter a stake of at least $1.") : t("Enter a stake of at least $1 on each bet.");
  else if (overMax) blocker = t("The most you can stake on one bet is {amount}.", { amount: formatMoney(info!.maxStake!) });
  else if (tooLittle) blocker = t("Your balance is too low for this slip. Tap here to ask for a top-up.");
  const needsMoney = Boolean(blocker) && !info?.blocked && closed.length === 0 && paused.length === 0 && !(acca && (hasSp || sameMatch || accaOdds > MAX_ACCUMULATOR_ODDS)) && !missingStake && !overMax && tooLittle;

  // Prices that moved since they were added: say so once per slip. The slip itself shows which ones.
  const movedShown = useRef(false);
  useEffect(() => {
    if (items.length === 0) movedShown.current = false;
    else if (moved && !movedShown.current) {
      movedShown.current = true;
      toast.info(t("Some prices moved since you added them. The new price is what you get."));
    }
  }, [moved, items.length, toast, t]);

  function setStake(id: string, stake: string) {
    onChange((list) => list.map((item) => (item.selectionId === id ? { ...item, stake } : item)));
  }

  async function place(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (placing || items.length === 0) return;
    // Why the slip can't go yet pops up when they try, instead of sitting in the slip.
    if (blocker) {
      // Too little money: a tap on the message asks their Manager or Owner for more.
      if (needsMoney) toast.warning(blocker, { onClick: () => void topUp.request() });
      else toast.warning(blocker);
      return;
    }
    const token = await getToken();
    if (!token) return;
    setPlacing(true);
    if (hasLive) toast.info(t("Live bets take a few seconds to confirm. If the price or score changes meanwhile, you'll see the new price first."));
    const body = JSON.stringify(
      acca
        ? { accumulator: { legs: items.map((item) => ({ selectionId: item.selectionId, odds: item.odds })), stake: accaStakeValue } }
        : { bets: items.map((item) => ({ selectionId: item.selectionId, stake: stakeValue(item.stake), odds: item.odds })) },
    );
    try {
      const result = await apiFetch<PlaceBetsResponse>("/bets", token, { method: "POST", body, idempotencyKey: idempotency.keyFor("/bets", body) });
      idempotency.done();
      setReceipt(result);
      toast.success(
        result.bets.length === 1
          ? result.bets[0].kind === "ACCUMULATOR"
            ? t("Your accumulator is on. {amount} was taken from your balance.", { amount: formatMoney(result.total) })
            : t("Your bet is on. {amount} was taken from your balance.", { amount: formatMoney(result.total) })
          : t("Your {count} bets are on. {amount} was taken from your balance.", { count: result.bets.length, amount: formatMoney(result.total) }),
      );
      onChange(() => []);
      onAccaStake("");
      onMode("singles");
      onPlaced();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("Couldn't place your bets");
      toast.error(message);
      // A price moved or a match closed: fetch the latest so the slip shows it. The API's English says which.
      if (/odds changed|closed|no longer exists|paused|score changed/i.test(err instanceof ApiError ? err.original : message)) onOddsChanged();
    } finally {
      setPlacing(false);
    }
  }

  if (receipt && items.length === 0) {
    return (
      <div className="card stack bet-slip">
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
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" />
            <path d="M13 5v2M13 11v2M13 17v0" />
          </svg>
          <strong>{t("Your slip is empty")}</strong>
          <p className="muted">{t("Tap a price to add a bet. Add two or more picks from different matches to combine them into an accumulator.")}</p>
        </div>
      ) : (
        <>
          {items.length >= 2 ? (
            <div className="bet-mode" role="group" aria-label={t("Bet type")}>
              <button type="button" className={`bet-mode-option${!acca ? " is-active" : ""}`} aria-pressed={!acca} onClick={() => onMode("singles")}>
                {t("Singles")}
              </button>
              <button type="button" className={`bet-mode-option${acca ? " is-active" : ""}`} aria-pressed={acca} onClick={() => onMode("accumulator")}>
                {t("Accumulator")}
              </button>
            </div>
          ) : null}
          <div className="bet-quick" role="group" aria-label={acca ? t("Accumulator stake") : t("Same stake on every bet")}>
            <span className="muted">{acca ? t("Stake") : t("Stake each")}</span>
            {QUICK_STAKES.map((amount) => (
              <button
                key={amount}
                type="button"
                className="bet-chip"
                onClick={() => (acca ? onAccaStake(String(amount)) : onChange((list) => list.map((item) => ({ ...item, stake: String(amount) }))))}
              >
                ${amount}
              </button>
            ))}
          </div>
          <ul className="bet-slip-items">
            {items.map((item) => {
              const stake = stakeValue(item.stake);
              return (
                <li key={item.selectionId} className={`bet-slip-item${item.closed ? " is-closed" : ""}`}>
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
                      ) : item.paused ? (
                        <span className="muted">{t("Paused")}</span>
                      ) : (
                        <>
                          {item.previousOdds !== undefined ? <s className="muted">{item.previousOdds.toFixed(2)}</s> : null}
                          <strong>{item.sp ? "SP" : item.odds.toFixed(2)}</strong>
                          {item.previousOdds !== undefined ? <PriceArrow move={{ up: item.odds > item.previousOdds, until: Infinity }} /> : null}
                        </>
                      )}
                    </span>
                    {acca ? (
                      <span className="bet-slip-return muted">{sameMatch && items.some((other) => other !== item && other.eventId === item.eventId) ? t("Same match as another pick") : ""}</span>
                    ) : (
                    <label className="bet-stake">
                      <span className="muted">$</span>
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
                    {acca ? null : (
                      <span className="bet-slip-return muted">
                        {item.sp ? t("Paid at the starting price") : stake > 0 ? t("Returns {amount}", { amount: formatMoney(returns(stake, item.odds)) }) : ""}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {acca ? (
            <div className="bet-slip-item bet-acca-stake">
              <div className="bet-slip-item-bottom">
                <span className="bet-slip-odds">
                  <span className="muted">{t("Combined")}</span>
                  <strong>{accaOdds.toFixed(2)}</strong>
                </span>
                <label className="bet-stake">
                  <span className="muted">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={1}
                    step="0.01"
                    placeholder={t("Stake")}
                    value={accaStake}
                    onChange={(e) => onAccaStake(e.target.value)}
                    aria-label={t("Accumulator stake")}
                  />
                </label>
              </div>
              <p className="muted bet-slip-note" style={{ margin: 0 }}>
                {t("Every pick has to win. A pick on a match that is called off drops out and the rest still count.")}
              </p>
            </div>
          ) : null}

          <dl className="bet-slip-totals">
            <div>
              <dt className="muted">{t("Total stake")}</dt>
              <dd>{formatMoney(totalStake)}</dd>
            </div>
            <div>
              <dt className="muted">{t("Potential return")}</dt>
              <dd>
                <strong>{formatMoney(totalReturn)}</strong>
                {hasSp && !acca ? <span className="muted"> {t("+ SP bets")}</span> : null}
              </dd>
            </div>
            {info ? (
              <div>
                <dt className="muted">{t("Balance after")}</dt>
                <dd>{formatMoney(info.balance - totalStake)}</dd>
              </div>
            ) : null}
          </dl>


          <button type="submit" className={`bet-place${blocker ? " is-blocked" : ""}`} disabled={placing} aria-disabled={Boolean(blocker)}>
            {placing
              ? <LoadingSpinner label={hasLive ? "Confirming live bet" : "Placing"} size="small" />
              : acca
                ? t("Place accumulator · {amount}", { amount: formatMoney(totalStake) })
                : tn(items.length, "Place bet · {amount}", "Place {count} bets · {amount}", { amount: formatMoney(totalStake) })}
          </button>
          {info ? <SlipLimits info={info} staking={totalStake} /> : null}
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

/** What a finished bet did to the balance, in big green or red: +$15.00, −$10.00, or the stake back. */
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

function MyBetsList({ status, version }: { status: "open" | "settled"; version: number }) {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const [data, setData] = useState<MyBets | null>(null);
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
      const next = await apiFetch<MyBets>(`/bets/mine?status=${status}`, token);
      if (cancelled) return;
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
  }, [getToken, status, version, toast, t]);

  async function loadMore() {
    const all = [...(data?.bets ?? []), ...more];
    const last = all[all.length - 1];
    if (!last) return;
    const token = await getToken();
    if (!token) return;
    setLoadingMore(true);
    try {
      const before = status === "open" ? last.placedAt : last.settledAt ?? last.placedAt;
      const next = await apiFetch<MyBets>(`/bets/mine?status=${status}&before=${encodeURIComponent(before)}`, token);
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
    return (
      <div className="loading-state">
        <LoadingSpinner label="Loading your bets" />
      </div>
    );
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
          <strong>{t("Accumulator")}</strong>
          <span className="muted">{tn(bet.legs.length, "{count} pick", "{count} picks")}</span>
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
          <dt className="muted">{t("Odds")}</dt>
          <dd>{bet.odds?.toFixed(2) ?? "–"}</dd>
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
  if (bet.kind === "ACCUMULATOR") return <AccumulatorCard bet={bet} />;
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
          {bet.selection ? <span className="muted">{ts(bet.selection.market)}</span> : null}
        </div>
        <StatusPill status={bet.status} />
      </div>
      {event ? (
        <div className="bet-card-event">
          <span>{event.name}</span>
          {score ? <strong className="odds-score">{score.home} – {score.away}</strong> : null}
        </div>
      ) : null}
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
