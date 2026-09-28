"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { BetLegs } from "../../../components/bet-legs";
import { LoadingSpinner } from "../../../components/loading-spinner";
import { useRealtime } from "../../../components/realtime-provider";
import { apiFetch, type Bet, type MyBets, type OddsEvent, type OddsSelection, type PlaceBetsResponse, type SlipInfo } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";

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
const QUICK_STAKES = [5, 10, 20, 50];
const MAX_SLIP = 10;
/** Matches the API's cap on an accumulator's combined odds. */
const MAX_ACCUMULATOR_ODDS = 5000;

const timeFormat = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "short" }).format(date);
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
    <Suspense fallback={<LoadingSpinner label="Loading" />}>
      <BetPage />
    </Suspense>
  );
}

function BetPage() {
  const { getToken } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "open" || tabParam === "settled" ? tabParam : "matches";

  const [events, setEvents] = useState<OddsEvent[] | null>(null);
  const [info, setInfo] = useState<SlipInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slip, setSlip] = useState<SlipItem[]>([]);
  const [slipLoaded, setSlipLoaded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [mode, setMode] = useState<SlipMode>("singles");
  const [accaStake, setAccaStake] = useState("");
  const [league, setLeague] = useState("");
  const [search, setSearch] = useState("");
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
    loadInfo().catch((err) => setError(err instanceof Error ? err.message : "Could not load your account"));
  }, [loadInfo]);

  const hasLive = (events ?? []).some((event) => event.live);

  useEffect(() => {
    if (tab !== "matches") return;
    loadEvents().catch((err) => setError(err instanceof Error ? err.message : "Could not load matches"));
  }, [tab, loadEvents]);

  // Prices move and matches kick off: refresh every minute while browsing, every 10 seconds while a match is live.
  useEffect(() => {
    if (tab !== "matches") return;
    const timer = setInterval(() => void loadEvents().catch(() => undefined), hasLive ? 10_000 : 60_000);
    return () => clearInterval(timer);
  }, [tab, loadEvents, hasLive]);

  // Keep the slip's prices in step with the latest odds, and close matches that kicked off.
  useEffect(() => {
    if (!events) return;
    const byId = new Map<string, { event: OddsEvent; suspended: boolean; selection: OddsSelection }>();
    for (const event of events) for (const market of event.markets) for (const selection of market.selections) byId.set(selection.id, { event, suspended: Boolean(market.suspended), selection });
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
    setError(null);
    setSlip((items) => {
      if (items.some((item) => item.selectionId === selection.id)) return items.filter((item) => item.selectionId !== selection.id);
      if (items.length >= MAX_SLIP) {
        setError(`A slip holds up to ${MAX_SLIP} bets.`);
        return items;
      }
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
  const groups: Array<[string, OddsEvent[]]> = [];
  for (const event of shown) {
    const label = event.live ? "Live now" : dayLabel(event.startsAt);
    const last = groups[groups.length - 1];
    if (last && last[0] === label) last[1].push(event);
    else groups.push([label, [event]]);
  }
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

  return (
    <div className="stack bet-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>Bet</h1>
          <p className="muted report-subtitle">Pick a price to add it to your slip. Live matches take bets while they&apos;re being played.</p>
        </div>
        {info ? (
          <div className="bet-balance">
            <span className="muted">Balance</span>
            <strong>{formatMoney(info.balance)}</strong>
          </div>
        ) : null}
      </div>

      {info?.blocked ? <p className="error-text" role="alert">{info.blocked}</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}

      <nav className="tabs-nav" aria-label="Betting sections">
        {(
          [
            ["matches", "Matches"],
            ["open", "Open bets"],
            ["settled", "Settled"],
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
              <input type="search" placeholder="Search teams or leagues" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search matches" />
              {leagues.length > 1 ? (
                <div className="bet-chips" role="group" aria-label="League">
                  <button type="button" className={`bet-chip${league === "" ? " is-active" : ""}`} onClick={() => setLeague("")}>
                    All
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
              <LoadingSpinner label="Loading matches" />
            ) : shown.length === 0 ? (
              <div className="card">
                <p className="muted" style={{ margin: 0 }}>
                  {events.length === 0 ? "No matches are open for bets right now. Check back soon." : "No matches match your search."}
                </p>
              </div>
            ) : (
              groups.map(([label, dayEvents]) => (
                <section key={label} className="stack odds-day">
                  <h2 className={`odds-day-label${label === "Live now" ? " bet-live-label" : ""}`}>{label}</h2>
                  {dayEvents.map((event) => (
                    <MatchCard key={event.id} event={event} selected={selected} onPick={toggle} />
                  ))}
                </section>
              ))
            )}
          </div>
          <aside className="bet-slip-desktop" aria-label="Bet slip">
            {slipPanel}
          </aside>
        </div>
      ) : (
        <MyBetsList status={tab} version={betsVersion} />
      )}

      {slip.length > 0 && tab === "matches" ? (
        <button type="button" className="bet-slip-bar" onClick={() => setSheetOpen(true)} aria-haspopup="dialog">
          <span className="bet-slip-count">{slip.length}</span>
          <span>Bet slip</span>
          <span className="bet-slip-bar-total">{totalStake > 0 ? formatMoney(totalStake) : "Add stakes"}</span>
        </button>
      ) : null}

      {sheetOpen ? (
        <div className="bet-sheet-layer" role="dialog" aria-modal="true" aria-label="Bet slip">
          <button type="button" className="bet-sheet-backdrop" aria-label="Close bet slip" onClick={() => setSheetOpen(false)} />
          <div className="bet-sheet">{slipPanel}</div>
        </div>
      ) : null}
    </div>
  );
}

function MatchCard({ event, selected, onPick }: { event: OddsEvent; selected: Set<string>; onPick: (event: OddsEvent, market: string, selection: OddsSelection) => void }) {
  const [showAll, setShowAll] = useState(false);
  const markets = showAll ? event.markets : event.markets.slice(0, 1);
  return (
    <article className={`card odds-event bet-match${event.live ? " is-live" : ""}`}>
      <header className="odds-event-header">
        <span className="muted odds-league">
          {event.league}
          {event.country ? ` · ${event.country}` : ""}
        </span>
        {event.live ? (
          <span className="status-pill is-active">{event.elapsed !== null ? `Live ${event.elapsed}'` : "Live"}</span>
        ) : (
          <span className="status-pill">{timeFormat.format(new Date(event.startsAt))}</span>
        )}
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
          <span className="muted">v</span>
        )}
        <span className="odds-team">
          {event.awayTeam ?? ""}
          <span className="team-badge" aria-hidden="true">{(event.awayTeam ?? "?").slice(0, 1)}</span>
        </span>
      </div>
      {event.live && !event.bettable ? <p className="muted bet-paused">Live betting is paused for a moment.</p> : null}
      {markets.map((market) => (
        <div key={market.id} className="odds-market">
          <span className="odds-market-name">
            {market.name}
            {market.suspended ? <span className="muted"> · Suspended</span> : null}
          </span>
          <div className="odds-selections">
            {market.selections.map((selection) => {
              const isSelected = selected.has(selection.id);
              const locked = !event.bettable || Boolean(market.suspended);
              return (
                <button
                  key={selection.id}
                  type="button"
                  className={`odds-selection bet-pick${isSelected ? " is-selected" : ""}`}
                  onClick={() => onPick(event, market.name, selection)}
                  aria-pressed={isSelected}
                  disabled={locked && !isSelected}
                  aria-label={`${selection.name} at ${selection.price.toFixed(2)}, ${market.name}, ${event.name}${locked ? ", suspended" : ""}`}
                >
                  <span className="odds-selection-name">{selection.name}</span>
                  <strong className="odds-price">{locked ? "–" : selection.price.toFixed(2)}</strong>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {event.markets.length > 1 ? (
        <footer className="odds-event-footer">
          <button type="button" className="text-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Fewer markets" : `${event.markets.length - 1} more markets`}
          </button>
        </footer>
      ) : null}
    </article>
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
  const idempotency = useIdempotencyKey();
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  if (info?.blocked) blocker = info.blocked;
  else if (closed.length > 0) blocker = `Remove ${closed.length === 1 ? "the match that has closed" : "the matches that have closed"} to continue.`;
  else if (paused.length > 0) blocker = `Live betting is paused on ${paused.length === 1 ? paused[0].eventName : "some of your picks"}. Wait a moment or remove ${paused.length === 1 ? "it" : "them"}.`;
  else if (acca && sameMatch) blocker = "An accumulator needs each pick from a different match. Remove one of the picks from the same match.";
  else if (acca && accaOdds > MAX_ACCUMULATOR_ODDS) blocker = `Combined odds can be at most ${MAX_ACCUMULATOR_ODDS}. Remove a pick to continue.`;
  else if (missingStake) blocker = acca ? "Enter a stake of at least $1." : "Enter a stake of at least $1 on each bet.";
  else if (overMax) blocker = `The most you can stake on one bet is ${formatMoney(info!.maxStake!)}.`;
  else if (tooLittle) blocker = "Your balance is too low for this slip. Ask your Manager for a top-up.";

  function setStake(id: string, stake: string) {
    setError(null);
    onChange((list) => list.map((item) => (item.selectionId === id ? { ...item, stake } : item)));
  }

  async function place(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (blocker || placing || items.length === 0) return;
    const token = await getToken();
    if (!token) return;
    setPlacing(true);
    setError(null);
    const body = JSON.stringify(
      acca
        ? { accumulator: { legs: items.map((item) => ({ selectionId: item.selectionId, odds: item.odds })), stake: accaStakeValue } }
        : { bets: items.map((item) => ({ selectionId: item.selectionId, stake: stakeValue(item.stake), odds: item.odds })) },
    );
    try {
      const result = await apiFetch<PlaceBetsResponse>("/bets", token, { method: "POST", body, idempotencyKey: idempotency.keyFor("/bets", body) });
      idempotency.done();
      setReceipt(result);
      onChange(() => []);
      onAccaStake("");
      onMode("singles");
      onPlaced();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not place your bets";
      setError(message);
      // A price moved or a match closed: fetch the latest so the slip shows it.
      if (/odds changed|closed|no longer exists|paused|score changed/i.test(message)) onOddsChanged();
    } finally {
      setPlacing(false);
    }
  }

  if (receipt && items.length === 0) {
    return (
      <div className="card stack bet-slip">
        <div className="bet-slip-header">
          <h2>Bets placed</h2>
          <button type="button" className="secondary bet-slip-close" onClick={onClose} aria-label="Close bet slip">
            ✕
          </button>
        </div>
        <p className="success-text" role="status" style={{ margin: 0 }}>
          {receipt.bets.length === 1 ? (receipt.bets[0].kind === "ACCUMULATOR" ? "Your accumulator is on" : "Your bet is on") : `Your ${receipt.bets.length} bets are on`}. {formatMoney(receipt.total)} was taken from your balance.
        </p>
        <ul className="bet-receipt">
          {receipt.bets.map((bet) => (
            <li key={bet.id}>
              <span>{bet.description}</span>
              <span className="muted">
                {formatMoney(bet.stake)} at {bet.odds?.toFixed(2)} · returns {formatMoney(bet.potentialPayout ?? 0)}
              </span>
            </li>
          ))}
        </ul>
        <div className="bet-slip-actions">
          <Link href="/dashboard/bet?tab=open" className="button-link" onClick={onClose}>
            See open bets
          </Link>
          <button type="button" className="secondary" onClick={() => setReceipt(null)}>
            New slip
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="card stack bet-slip" onSubmit={place}>
      <div className="bet-slip-header">
        <h2>
          Bet slip {items.length > 0 ? <span className="muted">({items.length})</span> : null}
        </h2>
        <span className="bet-slip-header-actions">
          {items.length > 0 ? (
            <button type="button" className="text-button" onClick={() => onChange(() => [])}>
              Clear
            </button>
          ) : null}
          <button type="button" className="secondary bet-slip-close" onClick={onClose} aria-label="Close bet slip">
            ✕
          </button>
        </span>
      </div>

      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Tap a price to add a bet. Add two or more picks from different matches to combine them into an accumulator.
        </p>
      ) : (
        <>
          {items.length >= 2 ? (
            <div className="bet-mode" role="group" aria-label="Bet type">
              <button type="button" className={`bet-mode-option${!acca ? " is-active" : ""}`} aria-pressed={!acca} onClick={() => onMode("singles")}>
                Singles
              </button>
              <button type="button" className={`bet-mode-option${acca ? " is-active" : ""}`} aria-pressed={acca} onClick={() => onMode("accumulator")}>
                Accumulator
              </button>
            </div>
          ) : null}
          <div className="bet-quick" role="group" aria-label={acca ? "Accumulator stake" : "Same stake on every bet"}>
            <span className="muted">{acca ? "Stake" : "Stake each"}</span>
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
                      <strong>{item.name}</strong>
                      <span className="muted">
                        {item.market} · {item.eventName}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary bet-slip-remove"
                      onClick={() => onChange((list) => list.filter((other) => other.selectionId !== item.selectionId))}
                      aria-label={`Remove ${item.name} from the slip`}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="bet-slip-item-bottom">
                    <span className={`bet-slip-odds${item.previousOdds !== undefined ? " has-moved" : ""}`}>
                      {item.closed ? (
                        <span className="error-text">Closed</span>
                      ) : item.paused ? (
                        <span className="muted">Paused</span>
                      ) : (
                        <>
                          {item.previousOdds !== undefined ? <s className="muted">{item.previousOdds.toFixed(2)}</s> : null}
                          <strong>{item.odds.toFixed(2)}</strong>
                        </>
                      )}
                    </span>
                    {acca ? (
                      <span className="bet-slip-return muted">{sameMatch && items.some((other) => other !== item && other.eventId === item.eventId) ? "Same match as another pick" : ""}</span>
                    ) : (
                    <label className="bet-stake">
                      <span className="muted">$</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={1}
                        step="0.01"
                        placeholder="Stake"
                        value={item.stake}
                        onChange={(e) => setStake(item.selectionId, e.target.value)}
                        aria-label={`Stake on ${item.name}`}
                        disabled={item.closed}
                      />
                    </label>
                    )}
                    {acca ? null : <span className="bet-slip-return muted">{stake > 0 ? `Returns ${formatMoney(returns(stake, item.odds))}` : ""}</span>}
                  </div>
                </li>
              );
            })}
          </ul>

          {acca ? (
            <div className="bet-slip-item bet-acca-stake">
              <div className="bet-slip-item-bottom">
                <span className="bet-slip-odds">
                  <span className="muted">Combined</span>
                  <strong>{accaOdds.toFixed(2)}</strong>
                </span>
                <label className="bet-stake">
                  <span className="muted">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={1}
                    step="0.01"
                    placeholder="Stake"
                    value={accaStake}
                    onChange={(e) => {
                      setError(null);
                      onAccaStake(e.target.value);
                    }}
                    aria-label="Accumulator stake"
                  />
                </label>
              </div>
              <p className="muted bet-slip-note" style={{ margin: 0 }}>
                Every pick has to win. A pick on a match that is called off drops out and the rest still count.
              </p>
            </div>
          ) : null}

          <dl className="bet-slip-totals">
            <div>
              <dt className="muted">Total stake</dt>
              <dd>{formatMoney(totalStake)}</dd>
            </div>
            <div>
              <dt className="muted">Potential return</dt>
              <dd>
                <strong>{formatMoney(totalReturn)}</strong>
              </dd>
            </div>
            {info ? (
              <div>
                <dt className="muted">Balance after</dt>
                <dd>{formatMoney(info.balance - totalStake)}</dd>
              </div>
            ) : null}
          </dl>

          {hasLive && !blocker ? <p className="muted bet-slip-note">Live bets take a few seconds to confirm. If the price or score changes meanwhile, you&apos;ll see the new price first.</p> : null}
          {moved && !error ? <p className="muted bet-slip-note">Some prices moved since you added them. The new price is what you get.</p> : null}
          {blocker ? <p className="muted bet-slip-note">{blocker}</p> : null}
          {error ? (
            <p className="error-text bet-slip-note" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="bet-place" disabled={Boolean(blocker) || placing}>
            {placing ? (hasLive ? "Confirming live bet…" : "Placing…") : acca ? `Place accumulator · ${formatMoney(totalStake)}` : `Place ${items.length === 1 ? "bet" : `${items.length} bets`} · ${formatMoney(totalStake)}`}
          </button>
          {info?.maxStake != null || info?.dailyLossLimit != null ? (
            <p className="muted bet-slip-note">
              Your limits: {info.maxStake != null ? `${formatMoney(info.maxStake)} a bet` : null}
              {info.maxStake != null && info.dailyLossLimit != null ? ", " : null}
              {info.dailyLossLimit != null ? `${formatMoney(info.dailyLossLimit)} daily losses` : null}.
            </p>
          ) : null}
        </>
      )}
    </form>
  );
}

const STATUS_LABEL: Record<Bet["status"], string> = { OPEN: "Open", WON: "Won", LOST: "Lost", VOID: "Void" };

function MyBetsList({ status, version }: { status: "open" | "settled"; version: number }) {
  const { getToken } = useAuth();
  const [data, setData] = useState<MyBets | null>(null);
  const [more, setMore] = useState<Bet[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

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
      setError(null);
    })().catch((err) => setError(err instanceof Error ? err.message : "Could not load your bets"));
    return () => {
      cancelled = true;
    };
  }, [getToken, status, version]);

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
      setError(err instanceof Error ? err.message : "Could not load more bets");
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) return <p className="error-text" role="alert">{error}</p>;
  if (!data) return <LoadingSpinner label="Loading your bets" />;
  const bets = [...data.bets, ...more];

  return (
    <div className="stack">
      {status === "open" && data.open.count > 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {data.open.count} open {data.open.count === 1 ? "bet" : "bets"} · {formatMoney(data.open.staked)} staked
        </p>
      ) : null}
      {bets.length === 0 ? (
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>
            {status === "open" ? "You have no open bets." : "No settled bets yet. Results appear here once a match finishes."}
          </p>
          {status === "open" ? (
            <Link href="/dashboard/bet" className="button-link" style={{ justifySelf: "start" }}>
              Browse matches
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
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function AccumulatorCard({ bet }: { bet: Bet }) {
  const decided = bet.legs.filter((leg) => leg.result !== null).length;
  const when =
    bet.status === "OPEN"
      ? `${decided} of ${bet.legs.length} picks settled`
      : bet.settledAt
        ? `Settled ${dateTimeFormat.format(new Date(bet.settledAt))}`
        : "";
  return (
    <li className={`card bet-card is-${bet.status.toLowerCase()}`}>
      <div className="bet-card-top">
        <div className="bet-card-name">
          <strong>Accumulator</strong>
          <span className="muted">{bet.legs.length} picks</span>
        </div>
        <span className={`status-pill bet-status-${bet.status.toLowerCase()}`}>{STATUS_LABEL[bet.status]}</span>
      </div>
      <BetLegs legs={bet.legs} />
      <dl className="bet-card-numbers">
        <div>
          <dt className="muted">Stake</dt>
          <dd>{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="muted">Odds</dt>
          <dd>{bet.odds?.toFixed(2) ?? "–"}</dd>
        </div>
        <div>
          <dt className="muted">{bet.status === "OPEN" ? "To return" : "Returned"}</dt>
          <dd>
            <strong>{formatMoney(bet.status === "OPEN" ? bet.potentialPayout ?? 0 : bet.payout)}</strong>
          </dd>
        </div>
      </dl>
      <p className="muted bet-card-when">
        {when}
        {bet.voidReason ? ` · ${bet.voidReason}` : ""}
      </p>
    </li>
  );
}

function BetCard({ bet }: { bet: Bet }) {
  if (bet.kind === "ACCUMULATOR") return <AccumulatorCard bet={bet} />;
  const event = bet.event;
  const score = event?.result ?? (event && event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING" ? { home: event.homeScore, away: event.awayScore } : null);
  let when = "";
  if (event && bet.status === "OPEN") {
    if (event.status === "LIVE") when = "Live now";
    else if (event.status === "POSTPONED") when = "Postponed";
    else if (event.status === "COMPLETED") when = "Finished, settling soon";
    else when = `Starts ${dateTimeFormat.format(new Date(event.startsAt))}`;
  }
  return (
    <li className={`card bet-card is-${bet.status.toLowerCase()}`}>
      <div className="bet-card-top">
        <div className="bet-card-name">
          <strong>{bet.selection?.name ?? bet.description}</strong>
          {bet.selection ? <span className="muted">{bet.selection.market}</span> : null}
        </div>
        <span className={`status-pill bet-status-${bet.status.toLowerCase()}`}>{STATUS_LABEL[bet.status]}</span>
      </div>
      {event ? (
        <div className="bet-card-event">
          <span>{event.name}</span>
          {score ? <strong className="odds-score">{score.home} – {score.away}</strong> : null}
        </div>
      ) : null}
      <dl className="bet-card-numbers">
        <div>
          <dt className="muted">Stake</dt>
          <dd>{formatMoney(bet.stake)}</dd>
        </div>
        <div>
          <dt className="muted">Odds</dt>
          <dd>{bet.odds?.toFixed(2) ?? "–"}</dd>
        </div>
        <div>
          <dt className="muted">{bet.status === "OPEN" ? "To return" : "Returned"}</dt>
          <dd>
            <strong>{formatMoney(bet.status === "OPEN" ? bet.potentialPayout ?? 0 : bet.payout)}</strong>
          </dd>
        </div>
      </dl>
      <p className="muted bet-card-when">
        {bet.status === "OPEN" ? when : bet.settledAt ? `Settled ${dateTimeFormat.format(new Date(bet.settledAt))}` : ""}
        {bet.voidReason ? ` · ${bet.voidReason}` : ""}
        {bet.status === "VOID" && !bet.voidReason ? " · Match called off, stake refunded" : ""}
      </p>
    </li>
  );
}
