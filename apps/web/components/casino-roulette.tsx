"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { HelpTip } from "./help-tip";
import { useI18n, type I18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { RouletteWheel, type RouletteWheelHandle } from "./roulette-wheel";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, RotatePhoneIcon, useFullScreen, usePrefersReducedMotion } from "./use-full-screen";
import { useGameKeys } from "./use-game-keys";
import { apiFetch, type RouletteResult, type RouletteRound, type RouletteState } from "../lib/api";
import { formatMoney } from "../lib/format";
import { msg } from "../lib/i18n/core";
import {
  CELL,
  NUMBERS_H,
  OUTSIDE,
  SPOTS,
  TABLE_H,
  TABLE_W,
  ZERO_W,
  colorOf,
  label,
  numberBox,
  outsideBox,
  payoutFor,
  spotAt,
  spotCentre,
} from "../lib/roulette";
import { useIdempotencyKey } from "../lib/use-idempotency-key";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** Each chip's colour, by value. */
const CHIP_COLORS: Record<string, string> = { "50": "#7fb8e6", "100": "#f2f2f2", "250": "#f3c33b", "500": "#d8262c", "1000": "#2f6fd6", "2500": "#1f9d55" };
const chipColor = (amount: number, chips: number[]) => CHIP_COLORS[String([...chips].reverse().find((chip) => chip <= amount + 1e-9) ?? chips[0])] ?? "#f2f2f2";
const chipText = (amount: number) => (amount >= 1000 ? `${Math.round(amount / 100) / 10}k` : amount % 1 === 0 ? String(amount) : amount.toFixed(1));

/** What the outside bets say on the table. */
const OUTSIDE_LABELS: Record<(typeof OUTSIDE)[number], string> = {
  "1ST12": msg("1st 12"),
  "2ND12": msg("2nd 12"),
  "3RD12": msg("3rd 12"),
  COL1: msg("2 to 1"),
  COL2: msg("2 to 1"),
  COL3: msg("2 to 1"),
  "1-18": "1–18",
  "19-36": "19–36",
  EVEN: msg("Even"),
  ODD: msg("Odd"),
  RED: "",
  BLACK: "",
};

const COLOR_NAMES = { RED: msg("Red"), BLACK: msg("Black"), GREEN: msg("Green") } as const;

type Bets = Record<string, number>;
const cents = (value: number) => Math.round(value * 100);
const totalOf = (bets: Bets) => Object.values(bets).reduce((sum, amount) => sum + cents(amount), 0) / 100;

/** How a spot reads in a list: "17", "Split 17/20", "Red". */
function spotName(spot: string, t: I18n["t"]): string {
  const outside = OUTSIDE_LABELS[spot as (typeof OUTSIDE)[number]];
  if (outside !== undefined) {
    if (spot === "RED") return t("Red");
    if (spot === "BLACK") return t("Black");
    if (spot.startsWith("COL")) return t("Column {number}", { number: spot.slice(3) });
    return t(outside);
  }
  const numbers = (SPOTS.get(spot) ?? []).map(label).join("/");
  const count = SPOTS.get(spot)?.length ?? 0;
  if (count === 1) return numbers;
  return `${count === 2 ? t("Split") : count === 3 ? t("Street") : count === 4 ? t("Corner") : t("Six line")} ${numbers}`;
}

/** European roulette for a Player: the wheel, the table, the chips and the last rounds. */
export function RouletteGame() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  const toast = useToast();
  const idempotency = useIdempotencyKey();
  const instant = usePrefersReducedMotion();
  const wheelRef = useRef<RouletteWheelHandle>(null);
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<RouletteState | null>(null);
  const [balance, setBalance] = useState(0);
  const [chip, setChip] = useState(1);
  /** The chips on the table, by spot, and the order they went down in (for Undo). */
  const [bets, setBets] = useState<Bets>({});
  const [placed, setPlaced] = useState<Bets[]>([]);
  /** The last round's chips, for Repeat. */
  const [lastBets, setLastBets] = useState<Bets>({});
  /** The round just played: shown on the table until the Player puts a chip down. */
  const [settled, setSettled] = useState<RouletteResult | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [history, setHistory] = useState<RouletteState["history"]>([]);
  const [recent, setRecent] = useState<RouletteRound[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(slotSound.on), []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<RouletteState>("/casino/roulette", token);
    setState(next);
    setBalance(next.balance);
    setHistory(next.history);
    setRecent(next.recent);
    setChip((current) => (next.game.chips.includes(current) ? current : next.game.chips[1] ?? next.game.chips[0]));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !spinning) setBalance(event.balance);
  });

  // A hint (over the limit, say) shows for a moment in the message box.
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 2600);
    return () => clearTimeout(timer);
  }, [hint]);

  /** Checks a new table against the limit and the balance; false (with a hint) if it doesn't fit. */
  function fits(next: Bets): boolean {
    if (!state) return false;
    const total = totalOf(next);
    if (total > state.tableMax + 1e-9) {
      setHint(t("Table limit {amount}", { amount: formatMoney(state.tableMax) }));
      return false;
    }
    if (total > balance + 1e-9) {
      setHint(t("Balance too low"));
      return false;
    }
    if (Object.keys(next).length > state.game.maxSpots) {
      setHint(t("Too many spots"));
      return false;
    }
    return true;
  }

  /** The table to build on: after a round, a fresh one. */
  const current = settled ? {} : bets;

  function place(spot: string) {
    if (spinning || !state || state.closed) return;
    slotSound.unlock();
    const base = current;
    const next = { ...base, [spot]: (cents(base[spot] ?? 0) + cents(chip)) / 100 };
    if (!fits(next)) return;
    slotSound.chip();
    if (settled) {
      setSettled(null);
      setPlaced([]);
    }
    setPlaced((list) => [...(settled ? [] : list), base]);
    setBets(next);
  }

  function undo() {
    if (spinning) return;
    slotSound.click();
    if (settled || placed.length === 0) return;
    setBets(placed[placed.length - 1]);
    setPlaced(placed.slice(0, -1));
  }

  function clear() {
    if (spinning) return;
    slotSound.click();
    setSettled(null);
    setPlaced([]);
    setBets({});
  }

  function double() {
    if (spinning) return;
    slotSound.unlock();
    const base = settled ? lastBets : bets;
    if (Object.keys(base).length === 0) return;
    const next = Object.fromEntries(Object.entries(base).map(([spot, amount]) => [spot, (cents(amount) * 2) / 100]));
    if (!fits(next)) return;
    slotSound.chip();
    setPlaced((list) => [...(settled ? [] : list), settled ? {} : bets]);
    setSettled(null);
    setBets(next);
  }

  function repeat() {
    if (spinning || Object.keys(lastBets).length === 0) return;
    slotSound.unlock();
    if (!fits(lastBets)) return;
    slotSound.chip();
    setPlaced(settled ? [] : [...placed, bets]);
    setSettled(null);
    setBets(lastBets);
  }

  async function spin() {
    if (!state || spinning) return;
    slotSound.unlock();
    // Straight after a round, Spin plays the same chips again.
    const table = settled ? lastBets : bets;
    if (Object.keys(table).length === 0) {
      setHint(t("Place your chips"));
      return;
    }
    if (!fits(table)) return;
    setSpinning(true);
    setSettled(null);
    setBets(table);
    setPlaced([]);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const path = "/casino/roulette/spin";
      const body = JSON.stringify({ bets: Object.entries(table).map(([spot, amount]) => ({ spot, amount })) });
      const result = await apiFetch<RouletteResult>(path, token, { method: "POST", body, idempotencyKey: idempotency.keyFor(path, body) });
      idempotency.done();
      // The stake leaves the balance as the ball goes; the win arrives when it lands.
      setBalance(result.balance - result.win);
      await wheelRef.current?.spin(result.stop);
      setBalance(result.balance);
      setLastBets(table);
      setSettled(result);
      setHistory((list) => [{ number: result.number, label: result.label, color: result.color }, ...list].slice(0, 16));
      setRecent((list) => [result.round, ...list].slice(0, 10));
      if (result.win > 0) {
        slotSound.win(result.win >= result.staked * 10);
        slotSound.coins(Math.min(1600, 500 + result.win * 20));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("The spin didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setSpinning(false);
    }
  }

  useGameKeys(rulesOpen);

  if (!state) return <PageLoading label="Loading the Casino" />;
  const shown = settled ? lastBets : bets;
  const total = totalOf(shown);
  const winners = new Map((settled?.winners ?? []).map((winner) => [winner.spot, winner.win]));
  const message = spinning
    ? t("No more bets")
    : hint
      ? hint
      : settled
        ? settled.win > 0
          ? t("{number} {color}: you win {amount}", { number: settled.label, color: t(COLOR_NAMES[settled.color]), amount: formatMoney(settled.win) })
          : `${settled.label} ${t(COLOR_NAMES[settled.color])}`
        : total > 0
          ? t("Bet {amount}", { amount: formatMoney(total) })
          : t("Place your chips");

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{state.game.name}</h1>
          <p className="muted report-subtitle">{t("European roulette with a single 0, played with your balance.")}</p>
          <p className="game-keys-hint">{t("Press Space to spin.")}</p>
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
        <>
          <div className="slot-rotate roulette-rotate" role="status">
            <RotatePhoneIcon />
            <strong>{t("Turn your phone sideways to play")}</strong>
            <span className="muted">{t("{name} plays with the phone held sideways. Turn it and the game opens.", { name: state.game.name })}</span>
          </div>

          <section ref={cabinet} className={`roulette-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={state.game.name}>
            <header className="slot-marquee roulette-marquee">
              <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
                ‹
              </Link>
              <span className="slot-title">{state.game.name}</span>
              <button type="button" className="slot-fullscreen roulette-rules-button" onClick={() => setRulesOpen(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
                ?
              </button>
              <button
                type="button"
                className="slot-fullscreen"
                onClick={() => void toggleFullScreen()}
                aria-label={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}
                title={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}
              >
                <FullScreenIcon exit={fullScreen !== "off"} />
              </button>
            </header>

            <div className="roulette-stage">
              <div className="roulette-wheel-box">
                <RouletteWheel ref={wheelRef} wheel={state.game.wheel} resting={history[0] ? state.game.wheel.indexOf(history[0].number) : null} instant={instant} />
                {settled ? (
                  <div className={`roulette-result is-${settled.color.toLowerCase()}`} role="status" key={settled.round.id}>
                    {settled.label}
                  </div>
                ) : null}
              </div>
              <div className="roulette-side">
                <div className="roulette-history" aria-label={t("Last numbers")}>
                  {history.length === 0 ? <span className="muted">{t("Last numbers show here")}</span> : null}
                  {history.map((row, index) => (
                    <span key={index} className={`roulette-history-number is-${row.color.toLowerCase()}`}>
                      {row.label}
                    </span>
                  ))}
                </div>
                <RouletteTable
                  bets={shown}
                  chips={state.game.chips}
                  winning={settled?.number ?? null}
                  winners={winners}
                  settled={settled !== null}
                  disabled={spinning}
                  onPlace={place}
                  i18n={i18n}
                />
              </div>
            </div>

            <div className="slot-controls roulette-controls">
              <div className="roulette-chips" role="radiogroup" aria-label={t("Chip")}>
                {state.game.chips.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={chip === value}
                    className={`roulette-chip${chip === value ? " is-on" : ""}`}
                    style={{ "--chip": CHIP_COLORS[String(value)] } as CSSProperties}
                    onClick={() => {
                      slotSound.unlock();
                      slotSound.click();
                      setChip(value);
                    }}
                  >
                    {chipText(value)}
                  </button>
                ))}
              </div>
              <button type="button" className={`slot-btn slot-sound${soundOn ? " is-on" : ""}`} aria-pressed={soundOn} aria-label={soundOn ? t("Sound on. Tap to turn it off.") : t("Sound off. Tap to turn it on.")} onClick={() => {
                slotSound.setOn(!soundOn);
                setSoundOn(!soundOn);
                if (!soundOn) slotSound.click();
              }}>
                <span aria-hidden="true">{soundOn ? "🔊" : "🔇"}</span>
              </button>
              <button type="button" className="slot-btn is-grey" disabled={spinning || settled !== null || placed.length === 0} onClick={undo}>
                {t("Undo")}
              </button>
              <button type="button" className="slot-btn is-grey" disabled={spinning || total === 0} onClick={clear}>
                {t("Clear")}
              </button>
              <button type="button" className="slot-btn" disabled={spinning || total === 0} onClick={double}>
                {t("Double")}
              </button>
              <button type="button" className="slot-btn" disabled={spinning || Object.keys(lastBets).length === 0 || (!settled && total > 0)} onClick={repeat}>
                {t("Repeat")}
              </button>
              <div className={`slot-message${settled && settled.win > 0 ? " is-win" : ""}`} aria-live="polite">
                <span>{message}</span>
                <small>
                  {t("Credits {amount}", { amount: formatMoney(balance) })}
                  <span className="roulette-max"> · {t("Max {amount}", { amount: formatMoney(state.tableMax) })}</span>
                </small>
              </div>
              <button type="button" className="slot-btn slot-start" data-key="Space" disabled={spinning || (total === 0 && Object.keys(lastBets).length === 0)} onClick={() => void spin()}>
                <span aria-hidden="true">⟳</span>
                {t("Spin")}
              </button>
            </div>
            {rulesOpen && fullScreen !== "off" ? <RouletteRules game={state.game} tableMax={state.tableMax} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
          </section>
        </>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last rounds")}
          <HelpTip text="Your newest roulette rounds. They're also in My money, as one Roulette line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No rounds yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((round) => (
              <div className="report-list-row" key={round.id}>
                <div>
                  <strong>
                    <span className={`roulette-history-number is-${round.color.toLowerCase()}`}>{round.label}</span>{" "}
                    {tn(round.bets.length, "{count} spot, {amount}", "{count} spots, {amount}", { amount: formatMoney(round.staked) })}
                  </strong>
                  <span className="muted">
                    {date(round.createdAt, TIME)}
                    {round.bets.some((bet) => bet.win > 0)
                      ? ` · ${round.bets
                          .filter((bet) => bet.win > 0)
                          .map((bet) => spotName(bet.spot, t))
                          .join(", ")}`
                      : ""}
                  </span>
                </div>
                <strong className={round.win > 0 ? "money-amount is-in" : "muted"}>{round.win > 0 ? `+${formatMoney(round.win)}` : `−${formatMoney(round.staked)}`}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen && fullScreen === "off" ? <RouletteRules game={state.game} tableMax={state.tableMax} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
    </div>
  );
}

/**
 * The betting table, drawn as SVG: tap a number, or a line or corner
 * between numbers, to put the chosen chip there. Hovering (with a mouse)
 * lights up the numbers a spot covers.
 */
function RouletteTable({
  bets,
  chips,
  winning,
  winners,
  settled,
  disabled,
  onPlace,
  i18n,
}: {
  bets: Bets;
  chips: number[];
  winning: number | null;
  winners: Map<string, number>;
  settled: boolean;
  disabled: boolean;
  onPlace(spot: string): void;
  i18n: I18n;
}) {
  const { t } = i18n;
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const covered = new Set(hover ? SPOTS.get(hover) ?? [] : []);

  const spotFrom = (event: ReactPointerEvent<SVGSVGElement>) => {
    const matrix = svg.current?.getScreenCTM();
    if (!svg.current || !matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return spotAt(point.x, point.y);
  };

  const numbers = Array.from({ length: 37 }, (_, i) => i);
  const isLit = (number: number) => covered.has(number) || winning === number;
  const outsideWon = (spot: string) => winning !== null && (SPOTS.get(spot) ?? []).includes(winning);

  return (
    <svg
      ref={svg}
      className={`roulette-table${disabled ? " is-disabled" : ""}`}
      viewBox={`-2 -2 ${TABLE_W + 4} ${TABLE_H + 4}`}
      role="group"
      aria-label={t("Betting table")}
      onPointerMove={(event) => event.pointerType === "mouse" && setHover(spotFrom(event))}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(event) => {
        if (disabled) return;
        const spot = spotFrom(event);
        if (spot) onPlace(spot);
      }}
    >
      <rect x={-2} y={-2} width={TABLE_W + 4} height={TABLE_H + 4} rx={8} className="roulette-felt" />
      {numbers.map((number) => {
        const box = numberBox(number);
        const color = colorOf(number);
        const zero = number === 0;
        return (
          <g key={number} className={`roulette-cell${isLit(number) ? " is-lit" : ""}${winning === number ? " is-winning" : ""}`}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} className="roulette-cell-box" />
            {zero ? (
              <rect x={box.x + 6} y={box.y + 8} width={box.w - 12} height={box.h - 16} rx={10} className="roulette-pip is-green" />
            ) : (
              <circle cx={box.x + box.w / 2} cy={box.y + box.h / 2} r={22} className={`roulette-pip is-${color.toLowerCase()}`} />
            )}
            <text x={box.x + box.w / 2} y={box.y + box.h / 2 + 1} className="roulette-number">
              {label(number)}
            </text>
          </g>
        );
      })}
      {OUTSIDE.map((spot) => {
        const box = outsideBox(spot);
        const lit = hover === spot || (settled && outsideWon(spot));
        return (
          <g key={spot} className={`roulette-cell${lit ? " is-lit" : ""}`}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} className="roulette-cell-box" />
            {spot === "RED" || spot === "BLACK" ? (
              <path
                d={`M${box.x + box.w / 2} ${box.y + 8} l24 ${box.h / 2 - 8} l-24 ${box.h / 2 - 8} l-24 -${box.h / 2 - 8} z`}
                className={`roulette-diamond is-${spot.toLowerCase()}`}
              />
            ) : (
              <text x={box.x + box.w / 2} y={box.y + box.h / 2 + 1} className="roulette-outside" transform={spot.startsWith("COL") ? `rotate(-90 ${box.x + box.w / 2} ${box.y + box.h / 2})` : undefined}>
                {t(OUTSIDE_LABELS[spot])}
              </text>
            )}
          </g>
        );
      })}
      {/* The table's lines, drawn over the boxes. */}
      <rect x={0} y={0} width={TABLE_W} height={TABLE_H} className="roulette-lines" />
      <line x1={ZERO_W} y1={0} x2={ZERO_W} y2={NUMBERS_H} className="roulette-line" />
      <line x1={0} y1={NUMBERS_H / 2} x2={ZERO_W} y2={NUMBERS_H / 2} className="roulette-line" />
      <line x1={ZERO_W} y1={NUMBERS_H} x2={ZERO_W + 12 * CELL} y2={NUMBERS_H} className="roulette-line" />
      {Object.entries(bets).map(([spot, amount]) => {
        const centre = spotCentre(spot);
        const won = winners.get(spot);
        const state = settled ? (won ? " is-won" : " is-lost") : "";
        return (
          <g key={spot} className={`roulette-placed${state}`} transform={`translate(${centre.x} ${centre.y})`}>
            <title>{`${spotName(spot, t)}: ${formatMoney(amount)}, ${t("pays {payout} to 1", { payout: payoutFor(spot) })}`}</title>
            <circle r={17} className="roulette-placed-chip" style={{ fill: chipColor(amount, chips) }} />
            <circle r={13} className="roulette-placed-ring" />
            <text className="roulette-placed-amount" y={1}>
              {chipText(amount)}
            </text>
            {won ? (
              <text className="roulette-placed-win" y={-24}>
                +{chipText(won)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function RouletteRules({ game, tableMax, onClose, i18n }: { game: RouletteState["game"]; tableMax: number; onClose: () => void; i18n: I18n }) {
  const { t } = i18n;
  const rows: Array<[string, string, number]> = [
    [t("Straight up"), t("One number, 0 included"), 35],
    [t("Split"), t("Two numbers side by side: chip on the line between them"), 17],
    [t("Street"), t("A row of three: chip on the bottom edge of the row"), 11],
    [t("Corner"), t("Four numbers: chip where they meet. 0, 1, 2 and 3 together too: chip at the bottom corner of 0"), 8],
    [t("Six line"), t("Two rows: chip on the bottom edge between them"), 5],
    [t("Dozen or column"), t("12 numbers: 1st, 2nd or 3rd 12, or a \"2 to 1\" row"), 2],
    [t("Red, black, even, odd, 1–18, 19–36"), t("18 numbers. They lose on 0."), 1],
  ];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="roulette-rules-title">
        <div className="modal-header">
          <h2 id="roulette-rules-title">{t("Pays and rules")}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("European roulette: 37 pockets, 0 to 36. Pick a chip, tap the table to place it, then spin. A winning chip comes back with its pay.")}
        </p>
        <div className="report-list">
          {rows.map(([name, how, pays]) => (
            <div className="report-list-row" key={name}>
              <div>
                <strong>{name}</strong>
                <span className="muted">{how}</span>
              </div>
              <strong>{t("{payout} to 1", { payout: pays })}</strong>
            </div>
          ))}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Chips from {min} to {max}. All the chips on the table together can be up to {limit} a spin: your max stake, if you have one. Your daily loss limit counts the Casino too.", {
            min: formatMoney(game.chips[0]),
            max: formatMoney(game.chips[game.chips.length - 1]),
            limit: formatMoney(tableMax),
          })}
        </p>
      </section>
    </div>
  );
}
