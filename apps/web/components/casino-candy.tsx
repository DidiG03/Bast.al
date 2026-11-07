"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CANDY_NAMES, CandyDefs, CandyIcon } from "./candy-symbols";
import { HouseHistory, HousePage, RulesSheet, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import type { CandyCell, CandyMode, CandyPaying, CandyRecord, CandySpinResult, CandyState, CandyStep } from "../lib/api";
import { formatMoney } from "../lib/format";

const COLUMNS = 6;
const ROWS = 5;
/**
 * How the candies move, ms. A fall of one row takes FALL_MS, of n rows FALL_MS × √n; landing takes LAND_MS more.
 * Columns start STAGGER_MS apart, and on a new spin each row up a little later than the one under it.
 */
const FALL_MS = 165;
const LAND_MS = 130;
const COLUMN_STAGGER_MS = 38;
const ROW_STAGGER_MS = 22;
const CASCADE_STAGGER_MS = 18;
/** On a new spin, how long after the old candies start to fall out the new ones follow them. */
const FOLLOW_MS = 90;
/** In a tumble, how far behind the candies above that fall the new ones drop in. */
const REFILL_LAG_MS = 50;
/** The winners glowing with their pay shown, then bursting, then a beat after everything lands. */
const GLOW_MS = 700;
const BURST_MS = 230;
const AFTER_LANDING_MS = 90;
const MULTIPLIER_MS = 1100;
const BETWEEN_FREE_MS = 450;
/** Turbo (Space held): every pause this much shorter. */
const TURBO = 0.35;
const AUTO_COUNTS = [10, 25, 50, 100] as const;
/** What each way to play costs, in times the bet, if the API doesn't say. */
const COST: Record<CandyMode, number> = { NORMAL: 1, ANTE: 1.25, BUY: 100, SUPER: 240 };
const MAX_BUY_BET = 500;

/**
 * A candy on the board: a piece with an id that stays the same while it's on the board, so when candies
 * under it burst it visibly falls from where it was to where it lands. Positions are column and row; rows
 * above the board are negative.
 */
type Piece = { id: number; cell: CandyCell; column: number; row: number; win: boolean };

const at = (column: number, row: number) => column * ROWS + row;

/** Where a piece is drawn: it is one cell big, so 100% moves it one cell. */
const place = (column: number, row: number, extra = "") => `translate(${column * 100}%, ${row * 100}%)${extra}`;

/** The pieces for a whole board, numbered on from `firstId`. */
function piecesOf(board: CandyCell[], firstId: number): Piece[] {
  return board.map((cell, index) => ({ id: firstId + index, cell, column: Math.floor(index / ROWS), row: index % ROWS, win: false }));
}

/** Easing that speeds up like a falling thing (ease-in quad), so pieces dropping together keep their spacing. */
const GRAVITY = "cubic-bezier(0.11, 0, 0.5, 0)";

/**
 * A piece falling from row `from` to row `to` in its column, then settling: a quick squash as it lands and a
 * small give back. The fall's time grows with the square root of the distance, as a real fall's does, so
 * pieces that start together fall at the same speed and never run into each other.
 */
function fall(column: number, from: number, to: number) {
  const fallMs = FALL_MS * Math.sqrt(to - from);
  const duration = fallMs + LAND_MS;
  const landed = fallMs / duration;
  const keyframes: Keyframe[] = [
    { transform: place(column, from), offset: 0, easing: GRAVITY },
    { transform: place(column, to, " scale(1.05, 0.9)"), offset: landed, easing: "ease-out" },
    { transform: place(column, to - 0.04, " scale(0.98, 1.03)"), offset: landed + (1 - landed) * 0.45, easing: "ease-in-out" },
    { transform: place(column, to), offset: 1 },
  ];
  return { keyframes, duration };
}

const quietBoard = (): CandyCell[] => Array.from({ length: COLUMNS * ROWS }, (_, i) => (["PEACH", "GRAPE", "MINT", "LEMON", "ORANGE", "GEM", "MOON", "STAR", "HEART"] as CandyCell[])[(i * 7) % 9]);

/** The round arrows on the spin button. */
function SpinArrows() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="candy-spin-arrows">
      <path d="M38 20a15 15 0 0 0-27-6" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M8 7v9h9" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 28a15 15 0 0 0 27 6" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M40 41v-9h-9" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Stars over a special-bet option, matching the candy cabinet look. */
function SpecialStars({ count, gold = false }: { count: number; gold?: boolean }) {
  if (count <= 0) return null;
  return (
    <span className={`candy-special-stars${gold ? " is-gold" : ""}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i}>★</span>
      ))}
    </span>
  );
}

/** Candy Cascade for a Player: 8 or more of a candy anywhere pay, winners burst and new candies tumble in. */
export function CandyGame() {
  useCasinoSession("candy", "Candy Cascade");
  const { t, tn } = useI18n();
  const g = useHouseGame<CandyState>("/casino/candy");
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();
  const [pieces, setPieces] = useState<Piece[]>(() => piecesOf(quietBoard(), 0));
  /** The pay of each win while its candies glow, shown over the middle of them. */
  const [pays, setPays] = useState<{ id: number; x: number; y: number; text: string }[]>([]);
  const [message, setMessage] = useState<{ text: string; tone?: "win" | "big" | "free" } | null>(null);
  const [roundWin, setRoundWin] = useState(0);
  const [free, setFree] = useState<{ left: number; won: number } | null>(null);
  const [multiplier, setMultiplier] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rules, setRules] = useState(false);
  const [autoLeft, setAutoLeft] = useState(0);
  const [autoMenu, setAutoMenu] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [turbo, setTurbo] = useState(false);
  /** The Special Bet: on, every spin costs 25% more and lands lollipops more often. */
  const [ante, setAnte] = useState(false);
  /** The Special Bet menu: closed, the option list, or a purchase to confirm. */
  const [buying, setBuying] = useState<null | "menu" | "BUY" | "SUPER">(null);
  const skip = useRef(false);
  const alive = useRef(true);
  const nextId = useRef(1000);
  const piecesRef = useRef(pieces);
  /** Each piece's element, by id, to move it. */
  const nodes = useRef(new Map<number, HTMLElement>());
  /** The moves under way, so a skip can finish them all at once. */
  const running = useRef(new Set<Animation>());
  /** Whoever is waiting for the board to be drawn after a change. */
  const drawn = useRef<(() => void)[]>([]);
  const reducedMotion = useRef(false);
  const autoRef = useRef(0);
  autoRef.current = autoLeft;
  /** Space held down: spins follow one another at turbo speed until it's let go. */
  const held = useRef(false);
  const speed = useRef(1);

  useEffect(() => {
    alive.current = true;
    setSoundOn(slotSound.on);
    reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Waits (shorter in turbo), unless the Player asked to skip to the end or the page is hidden. */
  const wait = useCallback((ms: number) => (skip.current || document.hidden ? Promise.resolve() : new Promise<void>((resolve) => window.setTimeout(resolve, ms * speed.current))), []);

  // Once a change to the board is on screen (and before it's painted), whoever waited for it carries on.
  useLayoutEffect(() => {
    const waiting = drawn.current;
    drawn.current = [];
    for (const resolve of waiting) resolve();
  }, [pieces]);

  /** Puts these pieces on the board and resolves once they're drawn, so they can be moved before anyone sees them. */
  const draw = useCallback(
    (next: Piece[]) =>
      new Promise<void>((resolve) => {
        piecesRef.current = next;
        drawn.current.push(resolve);
        setPieces(next);
      }),
    [],
  );

  /** Moves a piece (shorter in turbo); nothing moves when skipping, with the page hidden, or for reduced motion. */
  const move = useCallback((id: number, keyframes: Keyframe[], options: { duration: number; delay?: number; fill?: FillMode }): Animation | null => {
    const node = nodes.current.get(id);
    if (!node || skip.current || document.hidden || reducedMotion.current || typeof node.animate !== "function") return null;
    const animation = node.animate(keyframes, { ...options, duration: options.duration * speed.current, delay: (options.delay ?? 0) * speed.current });
    running.current.add(animation);
    const done = () => running.current.delete(animation);
    animation.finished.then(done, done);
    return animation;
  }, []);

  /** Resolves once all of these moves are over (or were cut short). */
  const landedAll = (animations: (Animation | null)[]) =>
    Promise.all(animations.map((animation) => animation?.finished.then(() => undefined, () => undefined))).then(() => undefined);

  /** A second press: every move under way jumps to its end. */
  const finishMoves = useCallback(() => {
    for (const animation of Array.from(running.current)) {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    }
  }, []);

  /** A new spin: the candies on the board fall out of the bottom and the new board drops in from above, column by column. */
  const dropIn = useCallback(
    async (board: CandyCell[]) => {
      const leaving = piecesRef.current.map((piece) => ({ ...piece, win: false }));
      const arriving = piecesOf(board, nextId.current);
      nextId.current += board.length;
      await draw([...leaving, ...arriving]);
      const moves: (Animation | null)[] = [];
      // Bottom row first, then each row above a little later; each column a little after the one before.
      const delayOf = (piece: Piece) => piece.column * COLUMN_STAGGER_MS + (ROWS - 1 - piece.row) * ROW_STAGGER_MS;
      for (const piece of leaving) {
        const out = ROWS + 0.2;
        moves.push(
          move(piece.id, [{ transform: place(piece.column, piece.row), easing: GRAVITY }, { transform: place(piece.column, piece.row + out) }], {
            duration: FALL_MS * Math.sqrt(out),
            delay: delayOf(piece),
            fill: "forwards",
          }),
        );
      }
      for (const piece of arriving) {
        // The new board starts as a stack just above the board, the whole height of it.
        const { keyframes, duration } = fall(piece.column, piece.row - ROWS, piece.row);
        moves.push(move(piece.id, keyframes, { duration, delay: FOLLOW_MS + delayOf(piece), fill: "backwards" }));
      }
      await landedAll(moves);
      await draw(arriving);
    },
    [draw, move],
  );

  /**
   * A tumble: the winners burst, the candies above them fall straight down their own column into the gaps, in the
   * same order, and new candies drop in from a stack above the column to fill what's left.
   */
  const tumble = useCallback(
    async (winning: Set<number>, next: CandyCell[]) => {
      const current = piecesRef.current;
      // The pop: a quick swell, then gone. The rest stay where they are meanwhile.
      const pops = current
        .filter((piece) => winning.has(at(piece.column, piece.row)))
        .map((piece) =>
          move(
            piece.id,
            [
              { transform: place(piece.column, piece.row), opacity: 1 },
              { transform: place(piece.column, piece.row, " scale(1.2)"), opacity: 1, offset: 0.35 },
              { transform: place(piece.column, piece.row, " scale(0.15)"), opacity: 0 },
            ],
            { duration: BURST_MS, fill: "forwards" },
          ),
        );
      await landedAll(pops);
      if (!alive.current) return;
      setPays([]);
      const after: Piece[] = [];
      const moves: { id: number; column: number; from: number; to: number; delay: number }[] = [];
      for (let column = 0; column < COLUMNS; column++) {
        const staying = current.filter((piece) => piece.column === column && !winning.has(at(column, piece.row))).sort((a, b) => a.row - b.row);
        const fresh = ROWS - staying.length;
        const delay = column * CASCADE_STAGGER_MS;
        staying.forEach((piece, index) => {
          const row = fresh + index;
          after.push({ ...piece, row, cell: next[at(column, row)], win: false });
          if (row !== piece.row) moves.push({ id: piece.id, column, from: piece.row, to: row, delay });
        });
        for (let row = 0; row < fresh; row++) {
          const id = nextId.current++;
          after.push({ id, cell: next[at(column, row)], column, row, win: false });
          // Stacked above the column in the order they'll land, the lowest just over the top edge.
          moves.push({ id, column, from: row - fresh, to: row, delay: delay + REFILL_LAG_MS });
        }
      }
      await draw(after.sort((a, b) => a.id - b.id));
      await landedAll(
        moves.map((m) => {
          const { keyframes, duration } = fall(m.column, m.from, m.to);
          return move(m.id, keyframes, { duration, delay: m.delay, fill: "backwards" });
        }),
      );
    },
    [draw, move],
  );

  /** Plays a round back from what the API sent: every spin, every tumble. */
  const playBack = useCallback(
    async (result: CandySpinResult) => {
      const bet = result.bet;
      let total = 0;
      let freeLeft = result.round.bought ?? 0;
      const spins = result.round.spins;
      if (freeLeft > 0) {
        setFree({ left: freeLeft, won: 0 });
        setMessage({ text: result.round.mode === "SUPER" ? t("{count} super free spins!", { count: freeLeft }) : t("{count} free spins!", { count: freeLeft }), tone: "free" });
        slotSound.win(true);
        await wait(1300);
      }
      for (let s = 0; s < spins.length && alive.current; s++) {
        const spin = spins[s];
        if (spin.free) {
          freeLeft -= 1;
          setFree((current) => ({ left: Math.max(0, freeLeft), won: current?.won ?? 0 }));
          await wait(BETWEEN_FREE_MS);
        }
        setMultiplier(null);
        setMessage(null);
        slotSound.spinStart();
        await dropIn(spin.steps[0].board);
        let spinWin = 0;
        for (let i = 0; i < spin.steps.length && alive.current; i++) {
          const step = spin.steps[i];
          if (step.wins.length === 0) break;
          await wait(AFTER_LANDING_MS);
          const winning = new Set(step.wins.flatMap((win) => win.cells));
          await draw(piecesRef.current.map((piece) => ({ ...piece, win: winning.has(at(piece.column, piece.row)) })));
          setPays(
            step.wins.map((win, index) => {
              const columns = win.cells.map((cell) => Math.floor(cell / ROWS));
              const rows = win.cells.map((cell) => cell % ROWS);
              const mean = (list: number[]) => list.reduce((sum, n) => sum + n, 0) / list.length;
              return { id: nextId.current + index, x: ((mean(columns) + 0.5) / COLUMNS) * 100, y: ((mean(rows) + 0.5) / ROWS) * 100, text: formatMoney(win.pay * bet) };
            }),
          );
          const stepPay = step.wins.reduce((sum, win) => sum + win.pay, 0);
          spinWin += stepPay;
          setMessage({ text: step.wins.map((win) => `${win.count} × ${t(CANDY_NAMES[win.symbol])}: ${formatMoney(win.pay * bet)}`).join(" · "), tone: "win" });
          setRoundWin(Math.round((total + spinWin * bet) * 100) / 100);
          slotSound.win(stepPay >= 5);
          await wait(GLOW_MS);
          await tumble(winning, spin.steps[i + 1].board);
        }
        // A free spin that won: the multipliers on the board add up.
        if (spin.free && spin.multiplier > 1 && spin.tumbleWin > 0) {
          setMultiplier(spin.multiplier);
          setMessage({ text: t("{win} × {multiplier} = {total}", { win: formatMoney(spin.tumbleWin * bet), multiplier: spin.multiplier, total: formatMoney(spin.tumbleWin * spin.multiplier * bet) }), tone: "big" });
          slotSound.win(true);
          await wait(MULTIPLIER_MS);
        }
        if (spin.scatterPay > 0) {
          setMessage({ text: t("{count} lollipops: {amount}", { count: spin.scatters, amount: formatMoney(spin.scatterPay * bet) }), tone: "win" });
          await wait(GLOW_MS);
        }
        total = Math.round((total + spin.win * bet) * 100) / 100;
        setRoundWin(total);
        if (spin.freeSpinsWon > 0) {
          freeLeft += spin.freeSpinsWon;
          setFree((current) => ({ left: freeLeft, won: current?.won ?? 0 }));
          setMessage({ text: spin.free ? t("+{count} free spins!", { count: spin.freeSpinsWon }) : t("{count} free spins!", { count: spin.freeSpinsWon }), tone: "free" });
          slotSound.win(true);
          await wait(1400);
        }
        if (spin.free) setFree((current) => (current ? { ...current, won: Math.round((current.won + spin.win * bet) * 100) / 100 } : current));
      }
      setMultiplier(null);
      setFree(null);
      const won = result.win;
      setRoundWin(won);
      if (won > 0) {
        const times = Math.round((won / bet) * 100) / 100;
        setMessage({ text: result.round.capped ? t("Top win! {amount}", { amount: formatMoney(won) }) : times >= 20 ? t("Big win! {amount} ({times}×)", { amount: formatMoney(won), times }) : t("You won {amount}", { amount: formatMoney(won) }), tone: times >= 20 ? "big" : "win" });
      } else setMessage(null);
    },
    [t, wait, draw, dropIn, tumble],
  );

  const costTable = g.state?.game.cost ?? COST;
  const costOf = useCallback((mode: CandyMode) => Math.round(g.stake * 100 * costTable[mode]) / 100, [g.stake, costTable]);
  const spinMode: CandyMode = ante ? "ANTE" : "NORMAL";
  /** Why a spin can't be played now: the bet over the max, or (with the Special Bet's 25%) over the balance. */
  const problem = g.stakeProblem ?? (g.state && costOf(spinMode) > g.balance + 1e-9 ? t("Your balance is too low for this stake.") : null);

  const play = useCallback(async (mode: CandyMode) => {
    if (!g.state) return;
    if (playing) {
      // A second press while it plays: straight to the end.
      skip.current = true;
      finishMoves();
      return;
    }
    if (mode === spinMode ? problem : costOf(mode) > g.balance + 1e-9) return;
    skip.current = false;
    setAutoMenu(false);
    setPlaying(true);
    g.setBusy(true);
    slotSound.unlock();
    setMessage(null);
    setRoundWin(0);
    const bet = g.stake;
    const cost = costOf(mode);
    const response = await g.send<CandySpinResult>("spin", { bet, mode });
    if (!response) {
      setPlaying(false);
      g.setBusy(false);
      setAutoLeft(0);
      held.current = false;
      return;
    }
    const paid = response.cost ?? cost;
    g.setBalance(Math.round((g.balance - paid) * 100) / 100);
    await playBack(response);
    if (!alive.current) return;
    g.setBalance(response.balance);
    g.tally(paid, response.win);
    g.setState((current) =>
      current
        ? { ...current, balance: response.balance, recent: [{ id: response.id, bet: paid, win: response.win, round: { game: "candy" as const, win: response.round.win, freeSpins: response.round.freeSpins, capped: response.round.capped, mode, bet }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) }
        : current,
    );
    skip.current = false;
    setPlaying(false);
    g.setBusy(false);
  }, [g, playBack, playing, spinMode, problem, costOf, finishMoves]);

  const spin = useCallback(() => play(spinMode), [play, spinMode]);

  // Autoplay, and Space held down: the next spin once one ends.
  useEffect(() => {
    if (playing || !g.state) return;
    if (autoLeft <= 0 && !held.current) return;
    if (problem) {
      setAutoLeft(0);
      held.current = false;
      return;
    }
    const timer = window.setTimeout(
      () => {
        if (autoRef.current > 0) setAutoLeft((left) => left - 1);
        else if (!held.current) return;
        void spin();
      },
      held.current ? 120 : 500,
    );
    return () => window.clearTimeout(timer);
  }, [playing, autoLeft, g.state, problem, spin, turbo]);

  // Space: a press spins (or skips to the end); held down, it keeps spinning in turbo until it's let go.
  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    };
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typing(event.target)) return;
      event.preventDefault();
      if (event.repeat) {
        if (!held.current) {
          held.current = true;
          speed.current = TURBO;
          setTurbo(true);
        }
        return;
      }
      void spin();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      held.current = false;
      speed.current = 1;
      setTurbo(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [spin]);

  const state = g.state;
  const payRows = useMemo(() => (state ? state.game.paying.map((symbol) => [symbol, state.game.pays[symbol]] as [CandyPaying, [number, number, number]]) : []), [state]);
  const allowed = useMemo(() => (state ? state.game.bets.filter((value) => value <= state.tableMax) : []), [state]);

  if (!state) return <PageLoading label="Loading the Casino" />;
  const stakeIndex = allowed.indexOf(g.stake);
  const stepStake = (by: number) => {
    const next = allowed[stakeIndex + by];
    if (next === undefined || playing || autoLeft > 0) return;
    g.setStake(next);
    slotSound.click();
  };
  const hint = turbo ? t("Turbo spin") : t("Hold Space for turbo spin");
  const maxBuyBet = state.game.maxBuyBet ?? MAX_BUY_BET;
  const buyNote = g.stake > maxBuyBet ? t("Bets up to {amount}", { amount: formatMoney(maxBuyBet) }) : null;
  const canSpecial = !playing && autoLeft === 0 && !free;
  const openSpecial = () => {
    if (!canSpecial) return;
    setBuying("menu");
    slotSound.click();
  };

  return (
    <HousePage
      title="Candy Cascade"
      intro={t("8 or more of a candy anywhere pay. Winners burst and new candies tumble in.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <section ref={cabinet} className={`candy-cabinet${fullScreen !== "off" ? " is-full" : ""}${free ? " is-free" : ""}`} aria-label="Candy Cascade">
          <CandyDefs />
          <header className="candy-top">
            <Link className="candy-round-key candy-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <p className="candy-headline">
              {t("Win up to {times}× bet", { times: state.game.maxWin.toLocaleString() })}
            </p>
          </header>

          <div className="candy-middle">
            {/* Beside the board on a wide screen: Special Bet and the win or the free spins. */}
            <aside className="candy-side">
              <button type="button" className={`candy-box is-ante${ante ? " is-on" : ""}`} onClick={openSpecial} disabled={!canSpecial} title={buyNote ?? undefined}>
                <strong>{t("Special Bet")}</strong>
                <small>{ante ? t("Double chance · +25%") : t("Ante, free spins & more")}</small>
              </button>
              <div className={`candy-box is-info${free ? " is-free" : ""}`} aria-live="polite">
                {free ? (
                  <>
                    <small>{t("Free spins")}</small>
                    <strong className="candy-side-big">{free.left}</strong>
                    <small>{t("Total win")}</small>
                    <strong>{formatMoney(free.won)}</strong>
                  </>
                ) : (
                  <>
                    <small>{t("Win")}</small>
                    <strong className="candy-side-big is-money">{formatMoney(roundWin)}</strong>
                  </>
                )}
              </div>
            </aside>

            <div className="candy-board-wrap">
              {/* On a phone: Special Bet, small, over the board. */}
              <div className="candy-extras">
                <button type="button" className={`candy-chip is-ante${ante ? " is-on" : ""}`} onClick={openSpecial} disabled={!canSpecial}>
                  {t("Special Bet")}
                </button>
              </div>
              {!free ? (
                <div className="candy-phone-win" aria-hidden="true">
                  {t("Win")} <span>{formatMoney(roundWin)}</span>
                </div>
              ) : null}
              {free ? (
                <div className="candy-free-strip" aria-hidden="true">
                  {tn(free.left, "{count} free spin left", "{count} free spins left")} · {formatMoney(free.won)}
                </div>
              ) : null}
              <div className={`candy-board${free ? " is-free" : ""}`} role="img" aria-label={t("The board")}>
                {/* The pieces sit in one layer clipped to the board: what's above or below it doesn't show. */}
                <div className="candy-grid" style={{ "--speed": turbo ? TURBO : 1 } as CSSProperties}>
                  {pieces.map((piece) => (
                    <span
                      key={piece.id}
                      ref={(node) => {
                        if (node) nodes.current.set(piece.id, node);
                        else nodes.current.delete(piece.id);
                      }}
                      className={`candy-piece${piece.win ? " is-win" : ""}`}
                      style={{ transform: place(piece.column, piece.row) }}
                    >
                      <CandyIcon cell={piece.cell} />
                    </span>
                  ))}
                  {pays.map((pay) => (
                    <span key={pay.id} className="candy-pay" style={{ left: `${pay.x}%`, top: `${pay.y}%` }}>
                      {pay.text}
                    </span>
                  ))}
                </div>
                {multiplier ? (
                  <div className="candy-multiplier-burst" aria-live="polite">
                    ×{multiplier}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <footer className="candy-bar">
            <div className="candy-keys">
              <button type="button" className="candy-round-key" onClick={() => setRules(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
                i
              </button>
              <button
                type="button"
                className="candy-round-key"
                aria-pressed={soundOn}
                aria-label={soundOn ? t("Sound on. Tap to turn it off.") : t("Sound off. Tap to turn it on.")}
                title={soundOn ? t("Sound on. Tap to turn it off.") : t("Sound off. Tap to turn it on.")}
                onClick={() => {
                  slotSound.setOn(!soundOn);
                  setSoundOn(!soundOn);
                  if (!soundOn) slotSound.click();
                }}
              >
                <span aria-hidden="true">{soundOn ? "🔊" : "🔇"}</span>
              </button>
              <button type="button" className="candy-round-key" onClick={() => void toggleFullScreen()} aria-label={fullScreen === "off" ? t("Full screen") : t("Exit full screen")} title={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}>
                <FullScreenIcon exit={fullScreen !== "off"} />
              </button>
            </div>

            <dl className="candy-money">
              <div>
                <dt>{t("Credit")}</dt>
                <dd>{formatMoney(g.balance)}</dd>
              </div>
              <div>
                <dt>{t("Bet")}</dt>
                <dd>{formatMoney(costOf(spinMode))}</dd>
              </div>
            </dl>

            <p className={`candy-say${message?.tone ? ` is-${message.tone}` : ""}`} aria-live="polite">
              {problem && !playing ? problem : message ? message.text : <span className="candy-hint">{hint}</span>}
            </p>

            <div className="candy-spin-group">
              <button type="button" className="candy-step" onClick={() => stepStake(-1)} disabled={playing || autoLeft > 0 || stakeIndex <= 0} aria-label={t("Lower the bet")}>
                −
              </button>
              <div className="candy-spin-stack">
                <button type="button" className={`candy-spin${playing ? " is-spinning" : ""}`} disabled={!!problem && !playing} onClick={() => void spin()} aria-label={playing ? t("Skip") : t("Spin {amount}", { amount: formatMoney(g.stake) })}>
                  <SpinArrows />
                </button>
                {autoLeft > 0 ? (
                  <button type="button" className="candy-auto-pill is-on" onClick={() => setAutoLeft(0)}>
                    {t("Stop ({count} left)", { count: autoLeft })}
                  </button>
                ) : (
                  <button type="button" className="candy-auto-pill" disabled={playing || !!problem} aria-expanded={autoMenu} onClick={() => setAutoMenu((open) => !open)}>
                    {t("Autoplay")}
                  </button>
                )}
                {autoMenu && autoLeft === 0 ? (
                  <div className="candy-auto-menu" role="menu" aria-label={t("Spins to play")}>
                    {AUTO_COUNTS.map((count) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={count}
                        onClick={() => {
                          setAutoMenu(false);
                          setAutoLeft(count);
                        }}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button type="button" className="candy-step" onClick={() => stepStake(1)} disabled={playing || autoLeft > 0 || stakeIndex >= allowed.length - 1} aria-label={t("Raise the bet")}>
                +
              </button>
            </div>
          </footer>

          {buying ? (
            <div className="candy-buy-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setBuying(null)}>
              <div className="candy-special" role="dialog" aria-modal="true" aria-label={t("Select a special bet")}>
                <button type="button" className="candy-special-close" onClick={() => setBuying(null)} aria-label={t("Close")}>
                  ×
                </button>
                <h2>{t("Select a special bet")}</h2>
                {buying === "menu" ? (
                  <>
                    <div className="candy-special-options">
                      <button
                        type="button"
                        className={`candy-special-option is-ante${ante ? " is-picked" : ""}`}
                        onClick={() => {
                          setAnte((on) => !on);
                          slotSound.click();
                          setBuying(null);
                        }}
                        disabled={costOf("ANTE") > g.balance + 1e-9 && !ante}
                      >
                        <SpecialStars count={1} />
                        <span className="candy-special-name">{t("Special Bet")}</span>
                        <strong className="candy-special-price">{formatMoney(costOf("ANTE"))}</strong>
                        <span className="candy-special-blurb">{t("About 2× chance of free spins")}</span>
                      </button>
                      <button
                        type="button"
                        className="candy-special-option is-buy"
                        onClick={() => setBuying("BUY")}
                        disabled={!!buyNote || costOf("BUY") > g.balance + 1e-9}
                        title={buyNote ?? undefined}
                      >
                        <SpecialStars count={2} />
                        <span className="candy-special-name">{t("Free spins")}</span>
                        <strong className="candy-special-price">{formatMoney(costOf("BUY"))}</strong>
                        <span className="candy-special-blurb">{t("{count} free spins, straight away", { count: state.game.freeSpins })}</span>
                      </button>
                      <button
                        type="button"
                        className="candy-special-option is-super"
                        onClick={() => setBuying("SUPER")}
                        disabled={!!buyNote || costOf("SUPER") > g.balance + 1e-9}
                        title={buyNote ?? undefined}
                      >
                        <SpecialStars count={3} gold />
                        <span className="candy-special-name">{t("Super free spins")}</span>
                        <strong className="candy-special-price">{formatMoney(costOf("SUPER"))}</strong>
                        <span className="candy-special-blurb">
                          {t("{count} free spins, every multiplier candy {min}× or more", { count: state.game.freeSpins, min: (state.game.superMultipliers ?? [5])[0] })}
                        </span>
                      </button>
                    </div>
                    <div className="candy-special-base">
                      <span>{t("Base bet")}</span>
                      <div className="candy-special-base-row">
                        <button type="button" className="candy-special-step" onClick={() => stepStake(-1)} disabled={stakeIndex <= 0} aria-label={t("Lower the bet")}>
                          −
                        </button>
                        <strong>{formatMoney(g.stake)}</strong>
                        <button type="button" className="candy-special-step" onClick={() => stepStake(1)} disabled={stakeIndex >= allowed.length - 1} aria-label={t("Raise the bet")}>
                          +
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="candy-buy-confirm">
                    <p>
                      {t("Buy {what} for {amount}?", { what: buying === "SUPER" ? t("super free spins") : t("free spins"), amount: formatMoney(costOf(buying)) })}
                    </p>
                    <p className="candy-buy-small">{t("That's {times}× your bet of {bet}. The free spins play out at that bet.", { times: costTable[buying], bet: formatMoney(g.stake) })}</p>
                    <div className="candy-buy-actions">
                      <button type="button" className="candy-buy-cancel" onClick={() => setBuying("menu")}>
                        {t("Back")}
                      </button>
                      <button
                        type="button"
                        className="candy-buy-go"
                        onClick={() => {
                          const mode = buying;
                          setAnte(false);
                          setBuying(null);
                          void play(mode);
                        }}
                      >
                        {t("Buy for {amount}", { amount: formatMoney(costOf(buying)) })}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>
      }
      history={
        <HouseHistory<CandyRecord>
          title="Your last spins"
          help="Your newest Candy Cascade spins, with the free spins they gave. They're also in My money, as one Candy Cascade line for each day."
          empty="No spins yet."
          rows={state.recent}
          describe={(round) => ({
            head: round && round.win > 0 ? `${Math.round(round.win * 100) / 100}×` : "—",
            detail: [
              round?.mode === "BUY" ? t("Bought free spins") : round?.mode === "SUPER" ? t("Bought super free spins") : round?.mode === "ANTE" ? t("Special Bet") : t("Spin"),
              ...(round && round.freeSpins > 0 && round.mode !== "BUY" && round.mode !== "SUPER" ? [tn(round.freeSpins, "{count} free spin", "{count} free spins")] : []),
            ].join(" · "),
          })}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <CandyDefs />
            <p>{t("6 columns of 5 candies, and no lines: 8 or more of one candy anywhere on the board pay. The winning candies burst, the rest fall down and new candies drop in, and the board pays again for as long as it has a win.")}</p>
            <div className="candy-paytable">
              <div className="candy-paytable-head">
                <span />
                <small>8–9</small>
                <small>10–11</small>
                <small>12+</small>
              </div>
              {payRows.map(([symbol, pays]) => (
                <div className="candy-paytable-row" key={symbol}>
                  <span title={t(CANDY_NAMES[symbol])}>
                    <CandyIcon cell={symbol} />
                  </span>
                  {pays.map((pay, i) => (
                    <strong key={i}>{formatMoney(pay * g.stake)}</strong>
                  ))}
                </div>
              ))}
            </div>
            <p className="muted">{t("Pays shown for a stake of {amount}.", { amount: formatMoney(g.stake) })}</p>
            <p className="candy-rule-line">
              <CandyIcon cell="LOLLIPOP" />
              <span>
                {t("The lollipop pays anywhere, once the tumbles are over: 4 pay {four}, 5 pay {five}, 6 or more pay {six}. 4 or more give {count} free spins.", {
                  four: `${state.game.scatterPays["4"]}×`,
                  five: `${state.game.scatterPays["5"]}×`,
                  six: `${state.game.scatterPays["6"]}×`,
                  count: state.game.freeSpins,
                })}
              </span>
            </p>
            <p className="candy-rule-line">
              <CandyIcon cell="X10" />
              <span>
                {t("In free spins, multiplier candies from {min}× to {max}× drop in too, and stay. When a free spin's tumbles end with a win, every multiplier on the board adds up and multiplies that spin's win. {count} or more lollipops in a free spin give {more} more.", {
                  min: state.game.multipliers[0],
                  max: state.game.multipliers[state.game.multipliers.length - 1],
                  count: state.game.scattersForMore,
                  more: state.game.moreFreeSpins,
                })}
              </span>
            </p>
            <p>
              <strong>{t("Special Bet")}:</strong>{" "}
              {t("turned on, each spin costs 25% more ({amount} at your bet) and lands lollipops more often: free spins come about twice as often. Wins are counted from your bet, as usual.", { amount: formatMoney(costOf("ANTE")) })}
            </p>
            <p>
              <strong>{t("Buy feature")}:</strong>{" "}
              {t("start {count} free spins straight away for {buy}× your bet, or {count} super free spins (every multiplier candy {min}× or more) for {super}×. Free spins can be bought at bets up to {max}, and ask you to confirm first.", {
                count: state.game.freeSpins,
                buy: costTable.BUY,
                super: costTable.SUPER,
                min: (state.game.superMultipliers ?? [5])[0],
                max: formatMoney(state.game.maxBuyBet ?? MAX_BUY_BET),
              })}
            </p>
            <p>{t("Spin with the round button, or press Space; press again to skip to the end. Hold Space down for turbo spins, one after another, until you let go. − and + change the bet; Autoplay plays 10 to 100 spins.")}</p>
            <p>{t("A spin, with every free spin it gives, pays at most {times} times the stake. The free spins play out with the spin that gave them, so a spin is settled at once, even if you leave.", { times: state.game.maxWin.toLocaleString() })}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
