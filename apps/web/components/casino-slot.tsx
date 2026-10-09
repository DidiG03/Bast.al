"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { HelpTip } from "./help-tip";
import { useI18n, type I18n } from "./i18n-provider";
import { LoadingSpinner, PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { SlotReels, type ReelWin, type SlotReelsHandle } from "./slot-reels";
import { slotSound } from "./slot-sounds";
import { symbolImage } from "./slot-symbols";
import { useToast } from "./toaster";
import { FullScreenIcon, RotatePhoneIcon, useFullScreen, usePrefersReducedMotion } from "./use-full-screen";
import { useGameKeys } from "./use-game-keys";
import {
  apiFetch,
  type CasinoGamble,
  type CasinoGambleResult,
  type CardColor,
  type CardSuit,
  type CasinoFreeSpins,
  type CasinoSpinResult,
  type CasinoSpinRow,
  type CasinoState,
  type SlotSymbol,
} from "../lib/api";
import { formatMoney } from "../lib/format";
import { msg } from "../lib/i18n/core";
import { useIdempotencyKey } from "../lib/use-idempotency-key";

/** How often each symbol flashes past while the reels spin; looks only, the server decides where they stop. */
const SPIN_WEIGHTS: Partial<Record<SlotSymbol, number>> = { LEMON: 10, CHERRY: 8, ORANGE: 6, MELON: 6, GRAPES: 6, PLUM: 4, SEVEN: 3, STAR: 2 };

const SYMBOL_NAMES: Record<SlotSymbol, string> = {
  SEVEN: msg("Seven"),
  MELON: msg("Watermelon"),
  GRAPES: msg("Grapes"),
  PLUM: msg("Plum"),
  ORANGE: msg("Orange"),
  LEMON: msg("Lemon"),
  CHERRY: msg("Cherry"),
  STAR: msg("Star"),
};

export const SUIT_MARKS: Record<CardSuit, string> = { HEARTS: "♥", DIAMONDS: "♦", CLUBS: "♣", SPADES: "♠" };

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** Each line has its own colour, on the reels and in the list of wins. Book of Ra uses all 10. */
export const LINE_COLORS = ["#3fa9f5", "#ef3b3b", "#3cc45a", "#f5d02f", "#f27ad6", "#ff8c1a", "#9b6bff", "#2ee6d6", "#c2e83a", "#ff5f8f"];
const STAR_COLOR = "#ffffff";
/** A spin that pays this many times its bet gets the big-win treatment. */
const BIG_WIN = 20;

/**
 * Where each line's number sits at the edges: up or down from the middle of
 * its end row, in cells. Lines ending on the same row share it, spread out,
 * the higher numbers further from the middle row. The reels draw the line to
 * the same spot, so it runs straight into its number.
 */
export function lineEnds(shapes: number[][]): { left: number[]; right: number[] } {
  const side = (rowOf: (shape: number[]) => number) => {
    const ends = shapes.map(() => 0);
    for (const row of [0, 1, 2]) {
      const lines = shapes.map((shape, index) => ({ index, row: rowOf(shape) })).filter((line) => line.row === row);
      lines.sort((a, b) => (row === 0 ? b.index - a.index : a.index - b.index));
      lines.forEach((line, order) => (ends[line.index] = (order - (lines.length - 1) / 2) * 0.4));
    }
    return ends;
  };
  return { left: side((shape) => shape[0]), right: side((shape) => shape[shape.length - 1]) };
}

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
  const edges = lineEnds(game.lineShapes);
  const combos: Combo[] = [...result.lines]
    .sort((a, b) => b.win - a.win)
    .map((won) => {
      const color = LINE_COLORS[won.line % LINE_COLORS.length];
      const path = game.lineShapes[won.line].map((row, reel) => [reel, row] as [number, number]);
      const ends: [number, number] = [edges.left[won.line], edges.right[won.line]];
      return { key: `line-${won.line}`, line: won.line + 1, symbol: won.symbol, count: won.count, amount: won.win, freeSpins: 0, reel: { cells: won.cells, color, path, ends } };
    });
  if (result.scatter) {
    combos.push({
      key: "stars",
      line: null,
      symbol: game.scatter,
      count: result.scatter.count,
      amount: result.scatter.win,
      freeSpins: result.freeSpinsWon,
      reel: { cells: result.scatter.cells, color: STAR_COLOR, marks: result.scatter.cells },
    });
  }
  return combos;
}

/** Every win at once: all the cells, and every line drawn. */
export function overview(combos: Array<{ reel: ReelWin }>): ReelWin {
  const seen = new Map<string, [number, number]>();
  for (const cell of combos.flatMap((combo) => combo.reel.cells)) seen.set(cell.join(":"), cell);
  return {
    cells: Array.from(seen.values()),
    color: "#ffffff",
    paths: combos.flatMap((combo) => (combo.reel.path ? [{ path: combo.reel.path, color: combo.reel.color, ends: combo.reel.ends }] : [])),
    marks: combos.flatMap((combo) => combo.reel.marks ?? []),
  };
}

/** How long a win takes to count up, in milliseconds; the coin sound lasts as long. */
export const countUpTime = (amount: number) => Math.min(1600, 500 + amount * 40);

/** Counts up to `target` when it changes, so a win ticks up instead of just appearing. */
export function useCountUp(target: number, instant: boolean): number {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (instant || target <= 0) {
      setShown(target);
      return;
    }
    const duration = countUpTime(target);
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
/** The fruit slot, for a Player: the cabinet, double or nothing, the last spins and the rules. */
export function SlotGame() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  const toast = useToast();
  const idempotency = useIdempotencyKey();
  const gambleKey = useIdempotencyKey();
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
  /** Double or nothing: the win open to it, the last card drawn, and whether a guess is on its way. */
  const [gamble, setGamble] = useState<CasinoGamble | null>(null);
  const [card, setCard] = useState<{ suit: CardSuit; won: boolean; win: number } | null>(null);
  const [guessing, setGuessing] = useState(false);
  const countedWin = useCountUp(lastWin?.amount ?? 0, instant);
  /** Auto: spins again by itself until the Player stops it, a spin fails, or the balance runs out. */
  const [auto, setAuto] = useState(false);
  /** Sound on or off; remembered on this device. Read after the page loads, since the server can't know it. */
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(slotSound.on), []);

  /** Full screen: the browser's own, or the cabinet expanded over the page on an iPhone. */
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<CasinoState>("/casino", token);
    setState(next);
    setBalance(next.balance);
    setFreeSpins(next.freeSpins);
    setRecent(next.recent);
    setGamble(next.gamble);
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
    slotSound.unlock();
    setSpinning(true);
    setLastWin(null);
    setCombos([]);
    setShowing(null);
    setPinned(null);
    setGamble(null);
    setCard(null);
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
      setGamble(result.gamble);
      setRecent((list) => [result.spin, ...list].slice(0, 10));
      const won = combosFor(result, state.game);
      setCombos(won);
      showAll(won);
      if (result.win > 0) {
        slotSound.win(result.win >= result.spin.bet * BIG_WIN);
        slotSound.coins(countUpTime(result.win));
      }
      if (result.win > 0 || result.freeSpinsWon > 0) {
        setLastWin({ amount: result.win, lines: result.lines.length, freeSpinsWon: result.freeSpinsWon, big: result.win >= result.spin.bet * BIG_WIN });
      }
    } catch (err) {
      // The spin didn't happen: the reels go back to where they were.
      if (landing) {
        reels.current?.land(grid);
        await landing.catch(() => undefined);
      }
      setAuto(false);
      toast.error(err instanceof Error ? err.message : t("The spin didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setSpinning(false);
    }
  }

  /** Double or nothing: the server draws the card. */
  async function guess(pick: CardColor) {
    if (!gamble || guessing) return;
    slotSound.unlock();
    setGuessing(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const path = "/casino/gamble";
      const body = JSON.stringify({ pick });
      const result = await apiFetch<CasinoGambleResult>(path, token, { method: "POST", body, idempotencyKey: gambleKey.keyFor(path, body) });
      gambleKey.done();
      setCard({ suit: result.suit, won: result.won, win: result.win });
      slotSound.cardFlip();
      if (result.won) slotSound.gambleWin();
      else slotSound.gambleLose();
      setGamble(result.gamble);
      setBalance(result.balance);
      setRecent((list) => [result.spin, ...list].slice(0, 10));
      setLastWin((current) => (current ? { ...current, amount: result.win } : current));
      if (!result.won) {
        reels.current?.clear();
        setCombos([]);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("That didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setGuessing(false);
    }
  }

  async function takeWin() {
    setGamble(null);
    try {
      const token = await getToken();
      if (token) await apiFetch(`/casino/collect`, token, { method: "POST", body: "{}" });
    } catch {
      // Nothing to lose: the win is already in the balance, and the next spin ends double or nothing anyway.
    }
  }

  /** Auto: the next spin starts a moment after the last one lands; longer after a win, so it can be seen. */
  useEffect(() => {
    if (!auto || spinning || !state || !grid) return;
    const free = freeSpins !== null && freeSpins.remaining > 0;
    const affordable = free || ((state.maxStake === null || bet <= state.maxStake) && bet <= balance);
    if (state.closed || !affordable || !(reelsReady || plainGrid)) {
      setAuto(false);
      return;
    }
    const timer = setTimeout(() => void spin(), lastWin ? 1600 : 450);
    return () => clearTimeout(timer);
    // spin() is a new function every render; the values it reads are listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, spinning, state, grid, freeSpins, bet, balance, reelsReady, plainGrid, lastWin]);

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

  useGameKeys(rulesOpen);

  if (!state || !grid) return <PageLoading label="Loading the Casino" />;
  const playingFree = freeSpins !== null && freeSpins.remaining > 0;
  const tooBig = (value: number) => (state.maxStake !== null && value > state.maxStake) || value > balance;
  const winCells = new Set(combos.flatMap((combo, index) => (showing === null || showing === index ? combo.reel.cells.map((cell) => cell.join(":")) : [])));
  const canSpin = !state.closed && !spinning && (reelsReady || plainGrid) && (playingFree || !tooBig(bet));
  /** Bets within the Player's limit for one bet; the balance is checked when they spin. */
  const allowedBets = state.game.bets.filter((value) => state.maxStake === null || value <= state.maxStake);
  const stepBet = (direction: 1 | -1) => {
    slotSound.unlock();
    slotSound.click();
    const at = allowedBets.indexOf(bet);
    const next = allowedBets[Math.min(allowedBets.length - 1, Math.max(0, at + direction))];
    if (next !== undefined) setBet(next);
  };
  const maxBet = () => {
    slotSound.unlock();
    slotSound.click();
    const affordable = allowedBets.filter((value) => value <= balance);
    setBet(affordable[affordable.length - 1] ?? allowedBets[0] ?? bet);
  };
  /** The lines lit on the reels right now, by index; the markers at the sides light up with them. */
  const litLines = new Set(combos.flatMap((combo, index) => (combo.line !== null && (showing === null || showing === index) ? [combo.line - 1] : [])));
  const message = spinning
    ? t("Good luck!")
    : card
      ? card.won
        ? t("Win {amount}", { amount: formatMoney(card.win) })
        : t("Better luck next time")
      : lastWin
        ? t("Win {amount}", { amount: formatMoney(countedWin) })
        : playingFree
          ? tn(freeSpins.remaining, "{count} free spin left", "{count} free spins left")
          : tooBig(bet)
            ? bet > balance
              ? t("Balance too low for this bet")
              : t("Over your limit for one bet")
            : t("Please place your bet");

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{state.game.name}</h1>
          <p className="muted report-subtitle">{t("5 reels, 5 lines, played with your balance.")}</p>
          <p className="game-keys-hint">{t("Press Space to spin, and again to stop the reels.")}</p>
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
          <div className="slot-rotate" role="status">
            <RotatePhoneIcon />
            <strong>{t("Turn your phone sideways to play")}</strong>
            <span className="muted">{t("{name} plays with the phone held sideways. Turn it and the game opens.", { name: state.game.name })}</span>
          </div>

          <section ref={cabinet} className={`slot-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={state.game.name}>
            <header className="slot-marquee">
              <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
                ‹
              </Link>
              <span className="slot-title">{state.game.name}</span>
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

            <div className="slot-stage">
              <LineMarkers side="left" shapes={state.game.lineShapes} lit={litLines} />
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

                {(gamble && !auto) || card ? (
                  <GamblePanel gamble={gamble} card={card} cardKey={recent[0]?.id} guessing={guessing} onGuess={guess} onTake={takeWin} onContinue={() => setCard(null)} />
                ) : null}
              </div>
              <LineMarkers side="right" shapes={state.game.lineShapes} lit={litLines} />
            </div>

            <footer className="slot-controls">
              <button type="button" className="slot-btn" onClick={() => setRulesOpen(true)}>
                {t("Menu")}
              </button>
              <button
                type="button"
                className={`slot-btn slot-sound${soundOn ? " is-on" : ""}`}
                aria-pressed={soundOn}
                aria-label={soundOn ? t("Sound on. Tap to turn it off.") : t("Sound off. Tap to turn it on.")}
                onClick={() => {
                  slotSound.setOn(!soundOn);
                  setSoundOn(!soundOn);
                  if (!soundOn) slotSound.click();
                }}
              >
                <span aria-hidden="true">{soundOn ? "🔊" : "🔇"}</span>
              </button>
              <div className="slot-btn is-grey is-static">
                <small>{t("Lines")}</small>
                <b>{state.game.lines}</b>
              </div>
              <div className="slot-btn is-static slot-bet">
                <small>
                  <button type="button" onClick={() => stepBet(-1)} disabled={spinning || auto || playingFree} aria-label={t("Lower the bet")}>
                    −
                  </button>
                  {t("Total bet")}
                  <button type="button" onClick={() => stepBet(1)} disabled={spinning || auto || playingFree} aria-label={t("Raise the bet")}>
                    +
                  </button>
                </small>
                <b>{formatMoney(playingFree ? freeSpins.bet : bet)}</b>
              </div>
              <div className={`slot-message${lastWin || card?.won ? " is-win" : ""}`} aria-live="polite">
                <span>{message}</span>
                <small>
                  {t("Credits")}: {formatMoney(balance)}
                </small>
              </div>
              <button type="button" className="slot-btn" onClick={maxBet} disabled={spinning || auto || playingFree}>
                {t("Max bet")}
              </button>
              <button type="button" className={`slot-btn slot-auto${auto ? " is-on" : ""}`} aria-pressed={auto} onClick={() => setAuto((on) => !on)} disabled={!auto && !canSpin}>
                <small>{t("Auto")}</small>
                <span className="slot-switch" aria-hidden="true" />
              </button>
              <button type="button" className="slot-btn slot-start" data-key="Space" onClick={() => (auto ? setAuto(false) : spinning ? reels.current?.skip() : spin())} disabled={!auto && !spinning && !canSpin}>
                <span aria-hidden="true">⟳</span> {auto ? t("Stop") : t("Start")}
              </button>
            </footer>
            {rulesOpen && fullScreen !== "off" ? <Rules game={state.game} bet={playingFree ? freeSpins.bet : bet} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
          </section>

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
                  <strong>{combo.amount > 0 ? `+${formatMoney(combo.amount)}` : null}</strong>
                </button>
              ))}
              {combos.length > 1 ? <p className="muted casino-combos-hint">{t("Tap a win to see it on the reels.")}</p> : null}
            </div>
          ) : null}
        </>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last spins")}
          <HelpTip text="Your newest spins and double-or-nothing guesses. They're also in My money, as one Casino line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No spins yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((spin) => (
              <div className="report-list-row" key={spin.id}>
                <div>
                  <strong>
                    {spin.gamble
                      ? t("Double or nothing on {amount}: picked {pick}, card {card}", {
                          amount: formatMoney(spin.bet),
                          pick: spin.gamble.pick === "RED" ? t("Red") : t("Black"),
                          card: SUIT_MARKS[spin.gamble.suit],
                        })
                      : spin.free
                        ? t("Free spin at {amount}", { amount: formatMoney(spin.bet) })
                        : t("Spin at {amount}", { amount: formatMoney(spin.bet) })}
                  </strong>
                  <span className="muted">
                    {date(spin.createdAt, TIME)}
                    {spin.freeSpinsWon > 0 ? ` · ${tn(spin.freeSpinsWon, "{count} free spin won", "{count} free spins won")}` : ""}
                  </span>
                </div>
                <strong className={spin.win > 0 ? "money-amount is-in" : "muted"}>{spin.win > 0 ? `+${formatMoney(spin.win)}` : spin.gamble ? `−${formatMoney(spin.bet)}` : t("No win")}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen && fullScreen === "off" ? <Rules game={state.game} bet={playingFree ? freeSpins.bet : bet} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
    </div>
  );
}

/** The numbered markers at the side of the reels: each line's number where it starts (left) and ends (right), placed where its line meets the edge. */
export function LineMarkers({ side, shapes, lit }: { side: "left" | "right"; shapes: number[][]; lit: Set<number> }) {
  const ends = lineEnds(shapes)[side];
  return (
    <div className={`slot-markers is-${side}`} aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="slot-marker-row">
          {shapes.map((shape, index) =>
            (side === "left" ? shape[0] : shape[shape.length - 1]) === row ? (
              <span
                key={index}
                className={`slot-marker${lit.has(index) ? " is-lit" : ""}`}
                style={{ "--marker": LINE_COLORS[index % LINE_COLORS.length], top: `${50 + ends[index] * 100}%` } as CSSProperties}
              >
                {index + 1}
              </span>
            ) : null,
          )}
        </div>
      ))}
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
          <span key={`${reel}:${row}`} className={lit?.has(`${reel}:${row}`) ? "is-lit" : undefined}>
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
          {t("Pays shown for a {amount} spin. A line pays when the same symbol lands on it 3, 4 or 5 times in a row from the left reel; cherries pay from 2.", { amount: formatMoney(bet) })}
        </p>
        <div className="casino-paytable">
          {paying.map((symbol) => (
            <div key={symbol} className="casino-pay">
              <SymbolPicture symbol={symbol} alt="" />
              <span>{t(SYMBOL_NAMES[symbol])}</span>
              <span className="casino-pay-amounts">
                {game.linePays[symbol]!.map((pay, index) =>
                  pay > 0 ? (
                    <span key={index}>
                      <b>{index + 2}×</b> {money(pay)}
                    </span>
                  ) : null,
                )}
              </span>
            </div>
          ))}
          <div className="casino-pay">
            <SymbolPicture symbol={game.scatter} alt="" />
            <span>{t(SYMBOL_NAMES[game.scatter])}</span>
            <span className="casino-pay-amounts">
              {(["3", "4", "5"] as const).map((count) => (
                <span key={count}>
                  <b>{count}×</b> {money(game.scatterPays[count])}
                </span>
              ))}
            </span>
          </div>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Stars pay anywhere on the reels, not just on a line.")}
        </p>
        <div className="stack-tight">
          <strong>{t("The 5 lines")}</strong>
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
        <div className="stack-tight">
          <strong>{t("Double or nothing")}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {t("After a win you can guess whether a card is red or black. Right, and the win doubles; wrong, and it's lost. Up to {steps} guesses in a row, and up to {limit}. Take the win any time; your next spin takes it too.", {
              steps: game.gambleSteps,
              limit: formatMoney(game.gambleLimit),
            })}
          </p>
        </div>
      </section>
    </div>
  );
}

/**
 * Double or nothing after a win (both slots): the card, the win at stake,
 * red or black, and taking the win; then whether the guess was right.
 */
export function GamblePanel({
  gamble,
  card,
  cardKey,
  guessing,
  onGuess,
  onTake,
  onContinue,
}: {
  gamble: CasinoGamble | null;
  card: { suit: CardSuit; won: boolean; win: number } | null;
  /** Changes with each guess, so the card turns over again. */
  cardKey?: string;
  guessing: boolean;
  onGuess(pick: CardColor): void;
  onTake(): void;
  onContinue(): void;
}) {
  const { t, tn } = useI18n();
  return (
    <div className="slot-gamble">
      <div className={`casino-gamble${card ? (card.won ? " is-won" : " is-lost") : ""}`} aria-live="polite">
        <div className={`casino-card${card ? ` is-${card.suit === "HEARTS" || card.suit === "DIAMONDS" ? "red" : "black"}` : ""}`} key={cardKey}>
          {card ? SUIT_MARKS[card.suit] : "?"}
        </div>
        <div className="casino-gamble-body">
          {card ? <strong>{card.won ? t("Right! You now have {amount}.", { amount: formatMoney(card.win) }) : t("Wrong card. This win is lost.")}</strong> : <strong>{t("Double or nothing?")}</strong>}
          {gamble ? (
            <>
              <span className="muted">
                {t("Guess the card's colour: {amount} becomes {double}, or nothing.", { amount: formatMoney(gamble.amount), double: formatMoney(gamble.amount * 2) })}{" "}
                {tn(gamble.stepsLeft, "{count} guess left.", "{count} guesses left.")}
              </span>
              <div className="casino-gamble-actions">
                <button type="button" className="casino-pick is-red" disabled={guessing} onClick={() => onGuess("RED")}>
                  {t("Red")} ♥♦
                </button>
                <button type="button" className="casino-pick is-black" disabled={guessing} onClick={() => onGuess("BLACK")}>
                  {t("Black")} ♣♠
                </button>
                <button type="button" className="secondary" disabled={guessing} onClick={onTake}>
                  {t("Take {amount}", { amount: formatMoney(gamble.amount) })}
                </button>
              </div>
            </>
          ) : (
            <>
              {card?.won ? <span className="muted">{t("That's the most this win can be doubled. It's in your balance.")}</span> : null}
              <div className="casino-gamble-actions">
                <button type="button" className="secondary" onClick={onContinue}>
                  {t("Continue")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
