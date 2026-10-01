"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HelpTip } from "../../../components/help-tip";
import { useI18n, type I18n } from "../../../components/i18n-provider";
import { LoadingSpinner, PageLoading } from "../../../components/loading-spinner";
import { useRealtime } from "../../../components/realtime-provider";
import { SlotReels, type ReelWin, type SlotReelsHandle } from "../../../components/slot-reels";
import { symbolImage } from "../../../components/slot-symbols";
import { Stat } from "../../../components/commission-views";
import { useToast } from "../../../components/toaster";
import {
  apiFetch,
  type CasinoAdmin,
  type CasinoFreeSpins,
  type CasinoSpinResult,
  type CasinoSpinRow,
  type CasinoState,
  type MeResponse,
  type SlotSymbol,
} from "../../../lib/api";
import { formatMoney, formatSignedMoney } from "../../../lib/format";
import { msg } from "../../../lib/i18n/core";
import { addDays, startOfMonth, startOfWeek } from "../../../lib/time";
import { useIdempotencyKey } from "../../../lib/use-idempotency-key";

/** How often each symbol flashes past while the reels spin; looks only, the server decides where they stop. */
const SPIN_WEIGHTS: Partial<Record<SlotSymbol, number>> = { RED: 9, YELLOW: 8, FLAG: 6, GLOVES: 5, BOOT: 4, BALL: 3, TROPHY: 2, SEVEN: 1, WILD: 2, GOAL: 2 };

const SYMBOL_NAMES: Record<SlotSymbol, string> = {
  SEVEN: msg("Golden 7"),
  TROPHY: msg("Trophy"),
  BALL: msg("Ball"),
  BOOT: msg("Boot"),
  GLOVES: msg("Gloves"),
  FLAG: msg("Corner flag"),
  YELLOW: msg("Yellow card"),
  RED: msg("Red card"),
  WILD: msg("Wild"),
  GOAL: msg("Goal"),
};

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

export default function CasinoPage() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      setMe(await apiFetch<MeResponse>("/users/me", token));
    })().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <PageLoading label="Loading the Casino" />;
  return me.role === "PLAYER" ? <PlayerCasino /> : <CasinoOverview me={me} />;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Each line has its own colour, on the reels and in the list of wins. */
const LINE_COLORS = ["#f5c542", "#4fc3f7", "#ff7043", "#c77dff", "#66bb6a", "#ff5c8a", "#26c6da", "#ffa726", "#b5e655", "#8c9eff"];
const GOAL_COLOR = "#ffffff";
/** A spin that pays this many times its bet gets the big-win treatment. */
const BIG_WIN = 20;

/** One win from a spin: a line, or the goals. */
type Combo = {
  key: string;
  /** Line number from 1, or null for the goals. */
  line: number | null;
  symbol: SlotSymbol;
  count: number;
  amount: number;
  freeSpins: number;
  reel: ReelWin;
};

function combosFor(result: CasinoSpinResult, game: CasinoState["game"]): Combo[] {
  const combos: Combo[] = [...result.lines]
    .sort((a, b) => b.win - a.win)
    .map((won) => {
      const color = LINE_COLORS[won.line % LINE_COLORS.length];
      const path = game.lineShapes[won.line].map((row, reel) => [reel, row] as [number, number]);
      return { key: `line-${won.line}`, line: won.line + 1, symbol: won.symbol, count: won.count, amount: won.win, freeSpins: 0, reel: { cells: won.cells, color, path } };
    });
  if (result.scatter) {
    combos.push({
      key: "goals",
      line: null,
      symbol: game.scatter,
      count: result.scatter.count,
      amount: result.scatter.win,
      freeSpins: result.freeSpinsWon,
      reel: { cells: result.scatter.cells, color: GOAL_COLOR },
    });
  }
  return combos;
}

/** Every win at once: all the cells, and every line drawn. */
function overview(combos: Combo[]): ReelWin {
  const seen = new Map<string, [number, number]>();
  for (const cell of combos.flatMap((combo) => combo.reel.cells)) seen.set(cell.join(":"), cell);
  return {
    cells: Array.from(seen.values()),
    color: "#ffffff",
    paths: combos.flatMap((combo) => (combo.reel.path ? [{ path: combo.reel.path, color: combo.reel.color }] : [])),
  };
}

/** Counts up to `target` when it changes, so a win ticks up instead of just appearing. */
function useCountUp(target: number, instant: boolean): number {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (instant || target <= 0) {
      setShown(target);
      return;
    }
    const duration = Math.min(1600, 500 + target * 40);
    const started = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - started) / duration);
      setShown(Math.floor(target * (1 - (1 - progress) ** 3) * 100) / 100);
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, instant]);
  return shown;
}

/** The Player's slot. */
function PlayerCasino() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  const toast = useToast();
  const idempotency = useIdempotencyKey();
  const instant = usePrefersReducedMotion();
  const reels = useRef<SlotReelsHandle>(null);

  const [state, setState] = useState<CasinoState | null>(null);
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(1);
  const [freeSpins, setFreeSpins] = useState<CasinoFreeSpins | null>(null);
  const [recent, setRecent] = useState<CasinoSpinRow[]>([]);
  const [grid, setGrid] = useState<SlotSymbol[][] | null>(null);
  const [lastWin, setLastWin] = useState<{ amount: number; lines: number; freeSpinsWon: number; big: boolean } | null>(null);
  const [combos, setCombos] = useState<Combo[]>([]);
  /** The win lit up on the reels right now; null while they all show together. */
  const [showing, setShowing] = useState<number | null>(null);
  /** A win the Player tapped, shown on its own until they tap it again. */
  const [pinned, setPinned] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [reelsReady, setReelsReady] = useState(false);
  const [plainGrid, setPlainGrid] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const countedWin = useCountUp(lastWin?.amount ?? 0, instant);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<CasinoState>("/casino", token);
    setState(next);
    setBalance(next.balance);
    setFreeSpins(next.freeSpins);
    setRecent(next.recent);
    // Before the first spin the reels show one of each symbol across the rows.
    setGrid((current) => current ?? next.grid ?? Array.from({ length: next.game.reels }, (_, reel) => Array.from({ length: next.game.rows }, (_, row) => next.game.symbols[(reel * 2 + row) % next.game.symbols.length])));
    const allowed = next.game.bets.filter((value) => next.maxStake === null || value <= next.maxStake);
    setBet((current) => (allowed.includes(current) ? current : allowed[0] ?? next.game.bets[0]));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !spinning) setBalance(event.balance);
  });

  async function spin() {
    if (!state || spinning || !grid) return;
    setSpinning(true);
    setLastWin(null);
    setCombos([]);
    setShowing(null);
    setPinned(null);
    reels.current?.clear();
    const landing = reels.current?.start() ?? null;
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const path = "/casino/spin";
      const body = JSON.stringify({ bet });
      const result = await apiFetch<CasinoSpinResult>(path, token, { method: "POST", body, idempotencyKey: idempotency.keyFor(path, body) });
      idempotency.done();
      reels.current?.land(result.grid);
      await landing;
      setGrid(result.grid);
      setBalance(result.balance);
      setFreeSpins(result.freeSpins);
      setRecent((list) => [result.spin, ...list].slice(0, 10));
      const won = combosFor(result, state.game);
      setCombos(won);
      showAll(won);
      if (result.win > 0 || result.freeSpinsWon > 0) {
        setLastWin({ amount: result.win, lines: result.lines.length, freeSpinsWon: result.freeSpinsWon, big: result.win >= result.spin.bet * BIG_WIN });
      }
    } catch (err) {
      // The spin didn't happen: the reels go back to where they were.
      if (landing) {
        reels.current?.land(grid);
        await landing.catch(() => undefined);
      }
      toast.error(err instanceof Error ? err.message : t("The spin didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setSpinning(false);
    }
  }

  /** Lights up every win together, then each in turn; with one win, just that one. */
  function showAll(won: Combo[]) {
    setPinned(null);
    if (won.length === 0) return;
    if (won.length === 1) {
      reels.current?.present([won[0].reel], () => setShowing(0));
      return;
    }
    reels.current?.present([overview(won), ...won.map((combo) => combo.reel)], (index) => setShowing(index === 0 ? null : index - 1));
  }

  function pick(index: number) {
    if (pinned === index) {
      showAll(combos);
      return;
    }
    setPinned(index);
    setShowing(index);
    reels.current?.present([combos[index].reel], () => setShowing(index));
  }

  if (!state || !grid) return <PageLoading label="Loading the Casino" />;
  const playingFree = freeSpins !== null && freeSpins.remaining > 0;
  const tooBig = (value: number) => (state.maxStake !== null && value > state.maxStake) || value > balance;
  const winCells = new Set(combos.flatMap((combo, index) => (showing === null || showing === index ? combo.reel.cells.map((cell) => cell.join(":")) : [])));
  const canSpin = !state.closed && !spinning && (reelsReady || plainGrid) && (playingFree || !tooBig(bet));

  return (
    <div className="stack casino-page">
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Casino")}</h1>
          <p className="muted report-subtitle">{t("Golazo: 5 reels, 10 lines, played with your balance.")}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setRulesOpen(true)}>
          {t("Pays and rules")}
        </button>
      </div>

      {state.closed ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <section className="casino-machine">
          <div className="casino-meters">
            <div>
              <span>{t("Balance")}</span>
              <strong>{formatMoney(balance)}</strong>
            </div>
            <div className={lastWin ? "is-win" : undefined} aria-live="polite">
              <span>{t("Win")}</span>
              <strong>{lastWin ? formatMoney(countedWin) : "—"}</strong>
            </div>
            {playingFree ? (
              <div className="is-free">
                <span>{t("Free spins")}</span>
                <strong>{freeSpins.remaining}</strong>
              </div>
            ) : null}
          </div>

          <div className={`casino-window${lastWin?.big ? " is-big-win" : ""}`}>
            {lastWin?.big ? (
              <div className="casino-big-win" role="status">
                <span>{t("Big win!")}</span>
                <strong>{formatMoney(countedWin)}</strong>
              </div>
            ) : null}
            {plainGrid ? (
              <PlainGrid grid={grid} lit={combos.length > 0 ? winCells : null} />
            ) : (
              <SlotReels
                ref={reels}
                grid={grid}
                symbols={state.game.symbols}
                scatter={state.game.scatter}
                weights={SPIN_WEIGHTS}
                instant={instant}
                onReady={() => setReelsReady(true)}
                onFailed={() => setPlainGrid(true)}
              />
            )}
            {!reelsReady && !plainGrid ? <LoadingSpinner label="Setting up the reels" /> : null}
          </div>

          {lastWin ? (
            <p className="casino-win-line" role="status">
              {lastWin.freeSpinsWon > 0
                ? tn(lastWin.freeSpinsWon, "Goal! {count} free spin, and {amount} won.", "Goal! {count} free spins, and {amount} won.", { amount: formatMoney(lastWin.amount) })
                : tn(lastWin.lines, "You won {amount} on {count} line.", "You won {amount} on {count} lines.", { amount: formatMoney(lastWin.amount) })}
            </p>
          ) : null}

          {combos.length > 0 ? (
            <div className="casino-combos" role="group" aria-label={t("Your wins on this spin")}>
              {combos.map((combo, index) => (
                <button
                  key={combo.key}
                  type="button"
                  className={`casino-combo${showing === index ? " is-showing" : ""}`}
                  style={{ "--combo-color": combo.reel.color } as CSSProperties}
                  aria-pressed={pinned === index}
                  onClick={() => pick(index)}
                >
                  <span className="casino-combo-name">{combo.line === null ? t(SYMBOL_NAMES[combo.symbol]) : t("Line {number}", { number: combo.line })}</span>
                  <span className="casino-combo-symbols" aria-label={`${combo.count} × ${t(SYMBOL_NAMES[combo.symbol])}`}>
                    <SymbolPicture symbol={combo.symbol} alt="" />×{combo.count}
                  </span>
                  <strong>
                    {combo.amount > 0 ? `+${formatMoney(combo.amount)}` : null}
                    {combo.freeSpins > 0 ? <em>{tn(combo.freeSpins, "{count} free spin", "{count} free spins")}</em> : null}
                  </strong>
                </button>
              ))}
              {combos.length > 1 ? <p className="muted casino-combos-hint">{t("Tap a win to see it on the reels.")}</p> : null}
            </div>
          ) : null}

          <div className="casino-controls">
            <div className="bet-chips" role="group" aria-label={t("Bet per spin")}>
              {state.game.bets.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`bet-chip${bet === value ? " is-active" : ""}`}
                  aria-pressed={bet === value}
                  disabled={spinning || playingFree || tooBig(value)}
                  onClick={() => setBet(value)}
                >
                  {formatMoney(value)}
                </button>
              ))}
            </div>
            <button type="button" className="casino-spin" onClick={spin} disabled={!canSpin}>
              {spinning ? (
                <LoadingSpinner label="Spinning" size="small" />
              ) : playingFree ? (
                t("Free spin at {amount}", { amount: formatMoney(freeSpins.bet) })
              ) : (
                t("Spin {amount}", { amount: formatMoney(bet) })
              )}
            </button>
            {!playingFree && tooBig(bet) && !spinning ? (
              <p className="muted" style={{ margin: 0 }}>
                {bet > balance ? t("Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.") : t("That's more than your limit for one bet.")}
              </p>
            ) : null}
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last spins")}
          <HelpTip text="Your newest spins. Every spin is also in My money, as one Casino line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No spins yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((spin) => (
              <div className="report-list-row" key={spin.id}>
                <div>
                  <strong>{spin.free ? t("Free spin at {amount}", { amount: formatMoney(spin.bet) }) : t("Spin at {amount}", { amount: formatMoney(spin.bet) })}</strong>
                  <span className="muted">
                    {date(spin.createdAt, TIME)}
                    {spin.freeSpinsWon > 0 ? ` · ${tn(spin.freeSpinsWon, "{count} free spin won", "{count} free spins won")}` : ""}
                  </span>
                </div>
                <strong className={spin.win > 0 ? "money-amount is-in" : "muted"}>{spin.win > 0 ? `+${formatMoney(spin.win)}` : t("No win")}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen ? <Rules game={state.game} bet={playingFree ? freeSpins.bet : bet} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
    </div>
  );
}

/** A symbol's picture. It's drawn in the browser, so there's nothing for next/image to optimise. */
function SymbolPicture({ symbol, alt }: { symbol: SlotSymbol; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={symbolImage(symbol)} alt={alt} />;
}

/** When the reels can't be drawn (no WebGL): the same result as plain pictures. */
function PlainGrid({ grid, lit }: { grid: SlotSymbol[][]; lit: Set<string> | null }) {
  const { t } = useI18n();
  const rows = grid[0]?.length ?? 0;
  return (
    <div className="casino-plain" style={{ gridTemplateColumns: `repeat(${grid.length}, 1fr)` }}>
      {Array.from({ length: rows }, (_, row) =>
        grid.map((column, reel) => (
          <span key={`${reel}:${row}`} className={lit ? (lit.has(`${reel}:${row}`) ? "is-lit" : "is-dim") : undefined}>
            <SymbolPicture symbol={column[row]} alt={t(SYMBOL_NAMES[column[row]])} />
          </span>
        )),
      )}
    </div>
  );
}

function Rules({ game, bet, onClose, i18n }: { game: CasinoState["game"]; bet: number; onClose: () => void; i18n: I18n }) {
  const { t, tn } = i18n;
  const lineBet = bet / game.lines;
  const money = (lineBets: number) => formatMoney(Math.floor(lineBets * lineBet * 100 + 1e-6) / 100);
  const paying = game.symbols.filter((symbol) => game.linePays[symbol]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="casino-rules-title">
        <div className="modal-header">
          <h2 id="casino-rules-title">{t("Pays and rules")}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Pays shown for a {amount} spin. A line pays when the same symbol lands on it 3, 4 or 5 times in a row from the left reel.", { amount: formatMoney(bet) })}
        </p>
        <div className="casino-paytable">
          {paying.map((symbol) => (
            <div key={symbol} className="casino-pay">
              <SymbolPicture symbol={symbol} alt="" />
              <span>{t(SYMBOL_NAMES[symbol])}</span>
              <span className="casino-pay-amounts">
                {game.linePays[symbol]!.map((pay, index) => (
                  <span key={index}>
                    <b>{index + 3}×</b> {money(pay)}
                  </span>
                ))}
              </span>
            </div>
          ))}
          <div className="casino-pay">
            <SymbolPicture symbol={game.wild} alt="" />
            <span>{t(SYMBOL_NAMES[game.wild])}</span>
            <span className="casino-pay-amounts">{t("Stands in for any symbol except the goal. Only on reels 2, 3 and 4.")}</span>
          </div>
          <div className="casino-pay">
            <SymbolPicture symbol={game.scatter} alt="" />
            <span>{t(SYMBOL_NAMES[game.scatter])}</span>
            <span className="casino-pay-amounts">
              {(["3", "4", "5"] as const).map((count) => (
                <span key={count}>
                  <b>{count}×</b> {money(game.scatterPays[count])} + {tn(game.freeSpins[count], "{count} free spin", "{count} free spins")}
                </span>
              ))}
            </span>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Goals pay anywhere on the reels, not just on a line. Free spins play at the bet that won them and cost nothing; more goals during them add more.")}
        </p>
        <div className="stack-tight">
          <strong>{t("The 10 lines")}</strong>
          <div className="casino-lines">
            {game.lineShapes.map((shape, index) => (
              <svg key={index} viewBox={`0 0 ${game.reels * 10} ${game.rows * 10}`} role="img" aria-label={t("Line {number}", { number: index + 1 })}>
                {Array.from({ length: game.reels * game.rows }, (_, cell) => {
                  const reel = cell % game.reels;
                  const row = Math.floor(cell / game.reels);
                  return <rect key={cell} x={reel * 10 + 1} y={row * 10 + 1} width="8" height="8" rx="1.5" className={shape[reel] === row ? "is-on" : undefined} />;
                })}
              </svg>
            ))}
          </div>
        </div>
        <p style={{ margin: 0 }}>
          {t("On average spins pay back {rate}% of what they cost. Each spin is decided on our server, never on your phone.", { rate: game.payoutRate })}
        </p>
      </section>
    </div>
  );
}

type Range = "this-week" | "last-week" | "this-month";
const RANGES: Array<[Range, string]> = [
  ["this-week", msg("This week")],
  ["last-week", msg("Last week")],
  ["this-month", msg("This month")],
];

function rangeDates(range: Range): { from: Date; to: Date } {
  const now = new Date();
  if (range === "last-week") {
    const to = startOfWeek(now);
    return { from: addDays(to, -7), to };
  }
  return { from: range === "this-month" ? startOfMonth(now) : startOfWeek(now), to: now };
}

/** Super Admin, Owners and Managers: the switches, and how the Casino is doing per Player. */
function CasinoOverview({ me }: { me: MeResponse }) {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const toast = useToast();
  const [range, setRange] = useState<Range>("this-week");
  const [data, setData] = useState<CasinoAdmin | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const { from, to } = rangeDates(range);
    setData(await apiFetch<CasinoAdmin>(`/casino/admin?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`, token));
  }, [getToken, range, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // Reload when the period changes, not when the sign-in helpers do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  async function setOpen(open: boolean, ownerId?: string) {
    setSwitching(ownerId ?? "site");
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch("/casino/admin/open", token, { method: "POST", body: JSON.stringify({ open, ...(ownerId ? { ownerId } : {}) }) });
      toast.success(open ? t("The Casino is open.") : t("The Casino is closed."));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't change it"));
    } finally {
      setSwitching(null);
    }
  }

  const players = useMemo(() => data?.players ?? [], [data]);
  if (!data) return <PageLoading label="Loading the Casino" />;
  const isAdmin = me.role === "SUPER_ADMIN";
  const subtitle = isAdmin
    ? t("Open the Casino for the site and for each Owner's team, and see how it's doing.")
    : me.role === "OWNER"
      ? t("Open the Casino for your team, and see how your Players are doing on it.")
      : t("How your Players are doing in the Casino.");

  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: 0 }}>{t("Casino")}</h1>
        <p className="muted report-subtitle">{subtitle}</p>
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Open or closed")}
          <HelpTip text="Players see the Casino only when it's open for the whole site and for their team. Spins use the Player's balance, and their profit counts in Commissions like bets do." />
        </h2>
        {isAdmin || me.role === "OWNER" ? (
          <label className="casino-switch">
            <input type="checkbox" checked={data.siteOpen} disabled={!isAdmin || switching !== null} onChange={(event) => setOpen(event.target.checked)} />
            <span>
              <strong>{t("The whole site")}</strong>
              <span className="muted">{isAdmin ? t("Super Admin's switch. Off closes it for every team.") : data.siteOpen ? t("Super Admin has it open.") : t("Super Admin has it closed for now, so your Players don't see it yet.")}</span>
            </span>
          </label>
        ) : null}
        {data.teams.map((team) => (
          <label className="casino-switch" key={team.ownerId}>
            <input type="checkbox" checked={team.open} disabled={switching !== null} onChange={(event) => setOpen(event.target.checked, team.ownerId)} />
            <span>
              <strong>{me.role === "OWNER" ? t("Your team") : t("{name}'s team", { name: team.username })}</strong>
              <span className="muted">{team.open ? (data.siteOpen ? t("Open: Players can play.") : t("Open, but the site is closed.")) : t("Closed.")}</span>
            </span>
          </label>
        ))}
        {me.role === "MANAGER" ? (
          <p style={{ margin: 0 }}>{data.siteOpen && data.teamOpen ? t("Open: your Players can play.") : t("Closed. Your Owner decides whether it's open for your team.")}</p>
        ) : null}
      </section>

      <div className="card stack commission-period">
        <nav className="tabs-nav commission-range" aria-label={t("Period")}>
          {RANGES.map(([value, label]) => (
            <button type="button" key={value} className={`tab-button${range === value ? " is-active" : ""}`} aria-pressed={range === value} onClick={() => setRange(value)}>
              {t(label)}
            </button>
          ))}
        </nav>
      </div>

      <div className="report-grid">
        <Stat label={t("Spins")} value={String(data.totals.spins)} hint={tn(players.length, "{count} Player", "{count} Players")} />
        <Stat label={t("Staked")} value={formatMoney(data.totals.staked)} hint={t("What spins cost")} />
        <Stat label={t("Paid out")} value={formatMoney(data.totals.won)} hint={data.totals.payoutRate === null ? t("No spins yet") : t("{rate}% of what was staked", { rate: data.totals.payoutRate })} />
        <Stat label={t("Casino profit")} help="What Players lost in the Casino minus what they won. It's part of the team's profit in Commissions." value={formatSignedMoney(data.totals.net)} highlight={data.totals.net < 0 ? "bad" : "good"} />
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Players")}</h2>
        {players.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No spins in this period.")}</p>
        ) : (
          <div className="report-list">
            {players.map((player) => (
              <div className="report-list-row" key={player.id}>
                <div>
                  <strong>{player.username}</strong>
                  <span className="muted">
                    {tn(player.spins, "{count} spin", "{count} spins")} · {t("{amount} staked", { amount: formatMoney(player.staked) })} · {t("{amount} paid out", { amount: formatMoney(player.won) })}
                  </span>
                </div>
                <strong className={player.net < 0 ? "is-bad" : undefined}>{formatSignedMoney(player.net)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
