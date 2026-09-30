"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BetLegs } from "../../../components/bet-legs";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useToast } from "../../../components/toaster";
import { MarketPriceHistory } from "../../../components/price-history";
import { useRealtime } from "../../../components/realtime-provider";
import { ApiError, apiFetch, type Bet, type MyBets, type OddsEvent, type OddsSelection, type PlaceBetsResponse, type SlipInfo } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { msg } from "../../../lib/i18n/core";
import { HelpTip } from "../../../components/help-tip";
import { useTopUpRequest } from "../../../components/top-up-request";
import { pickLabel } from "../../../lib/picks";

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
};

const SLIP_STORAGE = "bastal-bet-slip";
/** How long a price shows its up or down arrow after it moves. */
const MOVE_SHOWN_MS = 15_000;

type PriceMove = { up: boolean; until: number };
const QUICK_STAKES = [5, 10, 20, 50];
const MAX_SLIP = 10;
/** Matches the API's cap on an accumulator's combined odds. */
const MAX_ACCUMULATOR_ODDS = 5000;

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const DATE_TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

function dayLabel(iso: string, { t, date: format }: I18n): string {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return t("Today");
  if (date.toDateString() === tomorrow.toDateString()) return t("Tomorrow");
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

function readSlip(): SlipItem[] {
  try {
    const raw = window.localStorage.getItem(SLIP_STORAGE);
    const parsed = raw ? (JSON.parse(raw) as SlipItem[]) : [];
    // Live picks stay on the slip for the length of a match; the next odds refresh closes any that ended.
    return Array.isArray(parsed) ? parsed.filter((item) => new Date(item.startsAt).getTime() > Date.now() - 3 * 3_600_000).slice(0, MAX_SLIP) : [];
  } catch {
    return [];
  }
}

function saveSlip(items: SlipItem[]) {
  try {
    window.localStorage.setItem(SLIP_STORAGE, JSON.stringify(items));
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
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, ts } = i18n;
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "open" || tabParam === "settled" ? tabParam : "matches";
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

  const loadEvents = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const [live, upcoming] = await Promise.all([apiFetch<OddsEvent[]>("/odds/events?filter=live", token), apiFetch<OddsEvent[]>("/odds/events?filter=upcoming", token)]);
    const next = [...live, ...upcoming];
    setEvents(next);
    return next;
  }, [getToken]);

  const loadInfo = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setInfo(await apiFetch<SlipInfo>("/bets/slip", token));
  }, [getToken]);

  useEffect(() => {
    setSlip(readSlip());
    setSlipLoaded(true);
  }, []);

  useEffect(() => {
    if (slipLoaded) saveSlip(slip);
  }, [slip, slipLoaded]);

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
  }, [matchParam, events, tab, router, toast, t]);

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
    if (tab !== "matches") return;
    loadEvents().catch((err) => {
      setFailed(true);
      toast.error(err instanceof Error ? err.message : t("Couldn't load the matches"));
    });
  }, [tab, loadEvents, toast, t]);

  // Prices move and matches kick off: refresh every minute while browsing, every 10 seconds while a match is live.
  useEffect(() => {
    if (tab !== "matches") return;
    const timer = setInterval(() => void loadEvents().catch(() => undefined), hasLive ? 10_000 : 60_000);
    return () => clearInterval(timer);
  }, [tab, loadEvents, hasLive]);

  // Every price seen so far, to tell which ones moved on the latest refresh.
  const lastPrices = useRef(new Map<string, number>());
  const [moves, setMoves] = useState<Map<string, PriceMove>>(new Map());
  useEffect(() => {
    if (!events) return;
    const now = Date.now();
    const moved = new Map<string, PriceMove>();
    for (const event of events)
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
  }, [events]);

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

  // Keep the slip's prices in step with the latest odds, and close matches that kicked off.
  useEffect(() => {
    if (!events) return;
    const byId = new Map<string, { event: OddsEvent; suspended: boolean; selection: OddsSelection }>();
    for (const event of events) for (const market of event.markets) for (const selection of market.selections) byId.set(selection.id, { event, suspended: Boolean(market.suspended || selection.suspended), selection });
    setSlip((items) =>
      items.map((item) => {
        const found = byId.get(item.selectionId);
        if (!found || (!found.event.bettable && !found.event.live)) return { ...item, closed: true, paused: false };
        const paused = !found.event.bettable || found.suspended;
        const live = found.event.live;
        const price = found.selection.price;
        if (price === item.odds) return { ...item, closed: false, paused, live };
        const previous = item.previousOdds ?? item.odds;
        return { ...item, closed: false, paused, live, odds: price, previousOdds: previous === price ? undefined : previous };
      }),
    );
  }, [events]);

  useRealtime((event) => {
    if (event.type === "balance.changed" || event.type === "bets.changed" || event.type === "resync") {
      void loadInfo().catch(() => undefined);
      setBetsVersion((v) => v + 1);
    }
  });

  function setTab(next: Tab) {
    router.replace(next === "matches" ? "/dashboard/bet" : `/dashboard/bet?tab=${next}`, { scroll: false });
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
        { selectionId: selection.id, eventId: event.id, eventName: event.name, startsAt: event.startsAt, market: marketName, name: selection.name, odds: selection.price, stake: lastStake, live: event.live },
      ];
    });
  }

  const leagues = useMemo(() => Array.from(new Set((events ?? []).map((e) => e.league))).sort(), [events]);
  const query = search.trim().toLowerCase();
  const shown = (events ?? []).filter(
    (event) => (event.bettable || event.live) && event.markets.length > 0 && (!league || event.league === league) && (!query || event.name.toLowerCase().includes(query) || event.league.toLowerCase().includes(query)),
  );
  const allGroups: Array<[string, OddsEvent[]]> = [];
  const liveLabel = t("Live now");
  for (const event of shown) {
    const label = event.live ? liveLabel : dayLabel(event.startsAt, i18n);
    const last = allGroups[allGroups.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else allGroups.push([label, [event]]);
  }
  // A day that no longer has matches (a search, a league filter) falls back to every day.
  const dayShown = day === "" ? "" : day === "live" ? liveLabel : day;
  const groups = dayShown && allGroups.some(([label]) => label === dayShown) ? allGroups.filter(([label]) => label === dayShown) : allGroups;
  const selected = new Set(slip.map((item) => item.selectionId));

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
      onOddsChanged={() => void loadEvents().catch(() => undefined)}
      onClose={() => setSheetOpen(false)}
    />
  );
  const totalStake = mode === "accumulator" && slip.length >= 2 ? stakeValue(accaStake) : slip.reduce((sum, item) => sum + stakeValue(item.stake), 0);

  // The first time, only the spinner shows until the account and the matches have loaded.
  if (!info || (tab === "matches" && events === null)) return failed ? null : <PageLoading label="Loading matches" />;

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
        <div className="bet-layout">
          <div className="stack bet-matches">
            <div className="bet-filters">
              <input type="search" placeholder={t("Search teams or leagues")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("Search matches")} />
              {allGroups.length > 1 ? (
                <div className="bet-chips bet-day-chips" role="group" aria-label={t("Day")}>
                  <button type="button" className={`bet-chip${groups === allGroups ? " is-active" : ""}`} onClick={() => setDay("")} aria-pressed={groups === allGroups}>
                    {t("All")}
                  </button>
                  {allGroups.map(([label, list]) => {
                    const key = label === liveLabel ? "live" : label;
                    const active = groups !== allGroups && groups[0][0] === label;
                    return (
                      <button key={label} type="button" className={`bet-chip${active ? " is-active" : ""}${key === "live" ? " is-live" : ""}`} onClick={() => setDay(active ? "" : key)} aria-pressed={active}>
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
                  <button type="button" className={`bet-chip${league === "" ? " is-active" : ""}`} onClick={() => setLeague("")}>
                    {t("All")}
                  </button>
                  {leagues.map((name) => (
                    <button key={name} type="button" className={`bet-chip${league === name ? " is-active" : ""}`} onClick={() => setLeague(league === name ? "" : name)}>
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
                  {events.length === 0 ? t("No matches are open for bets right now. Check back soon.") : t("No matches match your search.")}
                </p>
              </div>
            ) : (
              groups.map(([label, dayEvents]) => (
                <section key={label} className="stack odds-day">
                  <h2 className={`odds-day-label${label === liveLabel ? " bet-live-label" : ""}`}>
                    {label === liveLabel ? <span className="live-dot" aria-hidden="true" /> : null}
                    {label}
                    <span className="odds-day-count">{dayEvents.length}</span>
                  </h2>
                  {dayEvents.map((event) => (
                    <MatchCard key={event.id} event={event} selected={selected} onPick={toggle} focused={focused === event.id} moves={moves} />
                  ))}
                </section>
              ))
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

function MatchCard({
  event,
  selected,
  onPick,
  focused,
  moves,
}: {
  event: OddsEvent;
  selected: Set<string>;
  onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void;
  focused: boolean;
  moves: Map<string, PriceMove>;
}) {
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  const [showAll, setShowAll] = useState(false);
  // The match someone came here for opens with every market showing.
  useEffect(() => {
    if (focused) setShowAll(true);
  }, [focused]);
  const markets = showAll ? event.markets : event.markets.slice(0, 1);
  return (
    <article id={`match-${event.id}`} className={`card odds-event bet-match${event.live ? " is-live" : ""}${focused ? " is-focused" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league}
          {event.country ? ` · ${event.country}` : ""}
        </span>
        <span className="odds-event-header-side">
          {event.live ? (
            <span className="status-pill is-active">
              <span className="live-dot" aria-hidden="true" />
              {event.elapsed !== null ? t("Live {minute}'", { minute: event.elapsed }) : t("Live")}
            </span>
          ) : (
            <span className="status-pill">{date(event.startsAt, TIME)}</span>
          )}
          {/* Opens or closes the other markets from the top, so there's no scrolling down to close them. */}
          {event.markets.length > 1 ? (
            <button
              type="button"
              className={`markets-toggle${showAll ? " is-open" : ""}`}
              onClick={() => setShowAll(!showAll)}
              aria-expanded={showAll}
              aria-label={showAll ? t("Fewer markets") : tn(event.markets.length - 1, "{count} more market", "{count} more markets")}
            >
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
        {event.live && event.homeScore !== null && event.awayScore !== null ? (
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
      {event.live && !event.bettable ? <p className={`bet-paused${event.livePause === "goal" ? " is-goal" : ""}`}>{t(PAUSE_TEXT[event.livePause ?? "feed"] ?? PAUSE_TEXT.feed)}</p> : null}
      {markets.map((market) => (
        <div key={market.id} className="odds-market">
          <div className="odds-market-head">
            <span className="odds-market-name">
              {ts(market.name)}
              {market.suspended ? <span className="muted"> · {t("Suspended")}</span> : null}
            </span>
            <MarketPriceHistory selections={market.selections} compact />
          </div>
          <div className="odds-selections">
            {market.selections
              // Live, a market with many outcomes (correct score) hides the ones that can't happen any more.
              .filter((selection) => !(event.live && selection.suspended && !market.suspended && market.selections.length > 3))
              .map((selection) => {
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
          {/^(home_|away_)?cards_/.test(market.key) ? <p className="muted odds-market-rule">{t("Settles on the official match stats after 90 minutes. Every yellow and red card counts as 1.")}</p> : null}
          {/^(home_|away_)?corners_/.test(market.key) ? <p className="muted odds-market-rule">{t("Settles on the official match stats after 90 minutes.")}</p> : null}
        </div>
      ))}
      {event.markets.length > 1 ? (
        <footer className="odds-event-footer">
          <button type="button" className={`bet-more-markets${showAll ? " is-open" : ""}`} onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
            {showAll ? t("Fewer markets") : tn(event.markets.length - 1, "{count} more market", "{count} more markets")}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </footer>
      ) : null}
    </article>
  );
}

/** Why a live match isn't taking bets, in words a Player understands. */
const PAUSE_TEXT: Record<string, string> = {
  goal: msg("⚽ Goal! Live betting reopens in a moment, once the prices catch up."),
  swing: msg("Something big just happened in this match. Live betting reopens in a moment."),
  reopen: msg("Live betting is reopening. One moment."),
  late: msg("Live betting has closed for the last minutes of this match."),
  feed: msg("Live betting is paused for a moment."),
};

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
  const accaOdds = combinedOdds(items.map((item) => item.odds));
  const accaStakeValue = stakeValue(accaStake);
  const sameMatch = new Set(items.map((item) => item.eventId)).size < items.length;

  const totalStake = acca ? accaStakeValue : items.reduce((sum, item) => sum + stakeValue(item.stake), 0);
  const totalReturn = acca ? returns(accaStakeValue, accaOdds) : items.reduce((sum, item) => sum + returns(stakeValue(item.stake), item.odds), 0);
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
  else if (acca && sameMatch) blocker = t("An accumulator needs each pick from a different match. Remove one of the picks from the same match.");
  else if (acca && accaOdds > MAX_ACCUMULATOR_ODDS) blocker = t("Combined odds can be at most {max}. Remove a pick to continue.", { max: MAX_ACCUMULATOR_ODDS });
  else if (missingStake) blocker = acca ? t("Enter a stake of at least $1.") : t("Enter a stake of at least $1 on each bet.");
  else if (overMax) blocker = t("The most you can stake on one bet is {amount}.", { amount: formatMoney(info!.maxStake!) });
  else if (tooLittle) blocker = t("Your balance is too low for this slip. Tap here to ask for a top-up.");
  const needsMoney = Boolean(blocker) && !info?.blocked && closed.length === 0 && paused.length === 0 && !(acca && (sameMatch || accaOdds > MAX_ACCUMULATOR_ODDS)) && !missingStake && !overMax && tooLittle;

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
                {t("{stake} at {odds} · returns {amount}", { stake: formatMoney(bet.stake), odds: bet.odds?.toFixed(2) ?? "–", amount: formatMoney(bet.potentialPayout ?? 0) })}
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
                          <strong>{item.odds.toFixed(2)}</strong>
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
                    {acca ? null : <span className="bet-slip-return muted">{stake > 0 ? t("Returns {amount}", { amount: formatMoney(returns(stake, item.odds)) }) : ""}</span>}
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
        {bet.status === "OPEN" ? when : bet.settledAt ? t("Settled {when}", { when: date(bet.settledAt, DATE_TIME) }) : ""}
        {voidText(bet.voidReason, ts, t)}
        {bet.status === "VOID" && !bet.voidReason ? ` · ${t("Match called off, stake refunded")}` : ""}
      </p>
    </li>
  );
}
