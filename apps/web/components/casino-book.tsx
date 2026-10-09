"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { bookSymbolImage, drawBookSymbol, loadBookArt, prepareBookImages } from "./book-symbols";
import { BookMarquee } from "./book-marquee";
import { BookColumn, BookTempleDefs, BookWall, ReelBackdrop, useHallLayout } from "./book-temple";
import { GamblePanel, countUpTime, overview, useCountUp } from "./casino-slot";
import { HelpTip } from "./help-tip";
import { useI18n, type I18n } from "./i18n-provider";
import { LoadingSpinner, PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { SlotReels, type ReelWin, type SlotReelsHandle } from "./slot-reels";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, RotatePhoneIcon, useFullScreen, usePrefersReducedMotion } from "./use-full-screen";
import { useGameKeys } from "./use-game-keys";
import {
  apiFetch,
  type BookFeature,
  type BookPaying,
  type BookSpinResult,
  type BookSpinRow,
  type BookState,
  type BookSymbol,
  type CardColor,
  type CardSuit,
  type CasinoGamble,
  type CasinoGambleResult,
} from "../lib/api";
import { formatMoney } from "../lib/format";
import { msg } from "../lib/i18n/core";
import { useIdempotencyKey } from "../lib/use-idempotency-key";

/** How often each symbol flashes past while the reels spin; looks only, the server decides where they stop. */
const SPIN_WEIGHTS: Partial<Record<BookSymbol, number>> = {
  TEN: 5,
  JACK: 6,
  QUEEN: 6,
  KING: 5,
  ACE: 5,
  SCARAB: 3,
  STATUE: 3,
  PHARAOH: 2,
  EXPLORER: 1,
  BOOK: 1,
};

const SYMBOL_NAMES: Record<BookSymbol, string> = {
  EXPLORER: msg("Explorer"),
  PHARAOH: msg("Pharaoh"),
  STATUE: msg("Statue"),
  SCARAB: msg("Scarab"),
  ACE: msg("Ace"),
  KING: msg("King"),
  QUEEN: msg("Queen"),
  JACK: msg("Jack"),
  TEN: msg("Ten"),
  BOOK: msg("Book"),
};

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const BOOK_COLOR = "#ffd35a";
const EXPANDED_COLOR = "#ffffff";
/** A spin that pays this many times its bet gets the big-win treatment. */
const BIG_WIN = 20;
/** How many paid spins autoplay can run, and the wins that stop it (times the bet; 0 never). */
const AUTO_COUNTS = [10, 25, 50, 100];
const AUTO_STOPS = [0, 10, 50, 100];

/** Each line's colour, as on the original's numbered boxes (line 1 first). */
const LINE_COLORS = ["#3d8fe0", "#e8423a", "#2f9e44", "#f2e04a", "#f07fd8", "#b8e05a", "#f6a38f", "#8fd8e6", "#f8c48a", "#e2a7f2"];
/** Two green arrows chasing each other round a circle, for the START ring. */
function StartArrows() {
  const point = (degrees: number, r: number) => {
    const a = (degrees * Math.PI) / 180;
    return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r];
  };
  const arrow = (from: number, to: number) => {
    const [x0, y0] = point(from, 33);
    const [x1, y1] = point(to, 33);
    const [tx, ty] = point(to + 16, 33);
    const [ox, oy] = point(to, 42);
    const [ix, iy] = point(to, 24);
    return { arc: `M${x0} ${y0} A33 33 0 0 1 ${x1} ${y1}`, head: `M${ox} ${oy} L${tx} ${ty} L${ix} ${iy} Z` };
  };
  return (
    <svg className="book-start-arrows" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="book-start-green" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8aff7a" />
          <stop offset="1" stopColor="#1fa82e" />
        </linearGradient>
      </defs>
      {[arrow(200, 318), arrow(20, 138)].map(({ arc, head }) => (
        <g key={arc} fill="url(#book-start-green)" stroke="url(#book-start-green)">
          <path d={arc} fill="none" strokeWidth="8" />
          <path d={head} strokeWidth="1" strokeLinejoin="round" />
        </g>
      ))}
    </svg>
  );
}

/** The numbered boxes beside the reels, top to bottom, as on the original. Each line runs from its box on the left to its box on the right. */
const MARKERS = {
  left: [4, 2, 9, 6, 1, 7, 8, 3, 5, 10],
  right: [10, 4, 2, 8, 6, 1, 7, 9, 3, 5],
};

/** Where a line meets each edge: up or down from the middle of its end row, in cells, so it runs into its box. */
function lineEnds(shapes: number[][]): { left: number[]; right: number[] } {
  const rows = 3;
  const side = (order: number[], rowOf: (shape: number[]) => number) =>
    shapes.map((shape, line) => ((order.indexOf(line + 1) + 0.5) / order.length) * rows - (rowOf(shape) + 0.5));
  return {
    left: side(MARKERS.left, (shape) => shape[0]),
    right: side(MARKERS.right, (shape) => shape[shape.length - 1]),
  };
}

/** One win from a spin: a line, the books, or the special symbol filling its reels. */
type Combo = {
  key: string;
  kind: "line" | "books" | "expanded";
  line: number | null;
  symbol: BookSymbol;
  count: number;
  amount: number;
  reel: ReelWin;
};

function combosFor(result: BookSpinResult, game: BookState["game"]): Combo[] {
  const edges = lineEnds(game.lineShapes);
  const combos: Combo[] = [...result.lines]
    .sort((a, b) => b.win - a.win)
    .map((won) => ({
      key: `line-${won.line}`,
      kind: "line",
      line: won.line + 1,
      symbol: won.symbol,
      count: won.count,
      amount: won.win,
      reel: {
        cells: won.cells,
        color: LINE_COLORS[won.line % LINE_COLORS.length],
        path: game.lineShapes[won.line].map((row, reel) => [reel, row] as [number, number]),
        ends: [edges.left[won.line], edges.right[won.line]],
      },
    }));
  if (result.scatter) {
    combos.push({
      key: "books",
      kind: "books",
      line: null,
      symbol: game.book,
      count: result.scatter.count,
      amount: result.scatter.win,
      reel: {
        cells: result.scatter.cells,
        color: BOOK_COLOR,
        marks: result.scatter.cells,
      },
    });
  }
  return combos;
}

/** The special symbol's win once it has filled its reels: every cell of them, every line drawn. */
function expandedCombo(expansion: NonNullable<BookSpinResult["expansion"]>, game: BookState["game"]): Combo {
  const edges = lineEnds(game.lineShapes);
  const cells = expansion.reels.flatMap((reel) => Array.from({ length: game.rows }, (_, row) => [reel, row] as [number, number]));
  return {
    key: "expanded",
    kind: "expanded",
    line: null,
    symbol: expansion.symbol,
    count: expansion.reels.length,
    amount: expansion.win,
    reel: {
      cells,
      color: EXPANDED_COLOR,
      paths: game.lineShapes.map((shape, line) => ({
        path: shape.map((row, reel) => [reel, row] as [number, number]),
        color: LINE_COLORS[line],
        ends: [edges.left[line], edges.right[line]] as [number, number],
      })),
    },
  };
}

/** What covers the reels for a moment: the book choosing the special symbol, or the end of the free spins. */
type Overlay = { kind: "intro"; special: BookPaying; spins: number; retrigger: boolean } | { kind: "summary"; total: number; capped: boolean };

/** Book of Ra, for a Player: the cabinet, free spins, autoplay, double or nothing, the last spins and the rules. */
export function BookGame() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, tn, ts, date } = i18n;
  const toast = useToast();
  const idempotency = useIdempotencyKey();
  const gambleKey = useIdempotencyKey();
  const instant = usePrefersReducedMotion();
  const reels = useRef<SlotReelsHandle>(null);
  const hallLayout = useHallLayout();

  const [artReady, setArtReady] = useState(false);
  const [state, setState] = useState<BookState | null>(null);
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(1);
  const [feature, setFeature] = useState<BookFeature | null>(null);
  const [recent, setRecent] = useState<BookSpinRow[]>([]);
  const [grid, setGrid] = useState<BookSymbol[][] | null>(null);
  const [lastWin, setLastWin] = useState<{
    amount: number;
    big: boolean;
  } | null>(null);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [showing, setShowing] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [reelsReady, setReelsReady] = useState(false);
  const [plainGrid, setPlainGrid] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [gamble, setGamble] = useState<CasinoGamble | null>(null);
  const [card, setCard] = useState<{
    suit: CardSuit;
    won: boolean;
    win: number;
  } | null>(null);
  const [guessing, setGuessing] = useState(false);
  /** Autoplay: paid spins left, and the win (times the bet) that stops it; null when it's off. */
  const [auto, setAuto] = useState<{ left: number; stopAt: number } | null>(null);
  const [autoMenu, setAutoMenu] = useState(false);
  const [betMenu, setBetMenu] = useState(false);
  /** Double or nothing waits until each winning line has been shown once. */
  const [gambleShown, setGambleShown] = useState(true);
  const [autoStopAt, setAutoStopAt] = useState(0);
  const countedWin = useCountUp(lastWin?.amount ?? 0, instant);
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(slotSound.on), []);
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<BookState>("/casino/book", token);
    setState(next);
    setBalance(next.balance);
    setFeature(next.feature);
    setRecent(next.recent);
    setGamble(next.gamble);
    setGrid(
      (current) =>
        current ??
        next.grid ??
        Array.from({ length: next.game.reels }, (_, reel) =>
          Array.from({ length: next.game.rows }, (_, row) => next.game.symbols[(reel * 3 + row) % next.game.symbols.length]),
        ),
    );
    const allowed = next.game.bets.filter((value) => next.maxStake === null || value <= next.maxStake);
    setBet((current) => (allowed.includes(current) ? current : (allowed[0] ?? next.game.bets[0])));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // The pictures in the art folder, if any, before the reels are drawn.
    loadBookArt().finally(() => {
      setArtReady(true);
      prepareBookImages();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !spinning) setBalance(event.balance);
  });

  // Autoplay stops when the page is hidden: nobody is watching.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && setAuto(null);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, instant ? 0 : ms));

  async function spin() {
    if (!state || spinning || !grid || overlay) return;
    slotSound.unlock();
    const free = feature !== null;
    setSpinning(true);
    setBetMenu(false);
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
      const path = "/casino/book/spin";
      const body = JSON.stringify({ bet });
      const result = await apiFetch<BookSpinResult>(path, token, {
        method: "POST",
        body,
        idempotencyKey: idempotency.keyFor(path, body),
      });
      idempotency.done();
      reels.current?.land(result.grid);
      await landing;
      setGrid(result.grid);
      setBalance(result.balance);
      setRecent((list) => [result.spin, ...list].slice(0, 10));
      if (!free) setAuto((current) => (current ? { ...current, left: current.left - 1 } : current));

      // The line wins and the books first; in a free spin, then the special symbol filling its reels.
      let won = combosFor(result, state.game);
      setGambleShown(won.length === 0);
      if (won.length > 0) {
        setCombos(won);
        showAll(won, () => setGambleShown(true));
        if (result.expansion) await wait(1400);
      }
      if (result.expansion) {
        reels.current?.clear();
        result.expansion.reels.forEach((reel, index) => setTimeout(() => slotSound.expand(reel), instant ? 0 : index * 350));
        await reels.current?.expand(result.expansion.reels, result.expansion.symbol);
        won = [expandedCombo(result.expansion, state.game), ...won];
        setCombos(won);
        showAll(won, () => setGambleShown(true));
      }
      const big = result.win >= result.spin.bet * BIG_WIN;
      if (result.win > 0) {
        slotSound.win(big);
        slotSound.coins(countUpTime(result.win));
        setLastWin({ amount: result.win, big });
      }
      setFeature(result.feature);
      setGamble(result.gamble);

      // Free spins won: the book opens on the special symbol. Autoplay stops for it.
      if (result.freeSpinsWon > 0 && result.feature) {
        setAuto(null);
        await wait(result.win > 0 ? 1200 : 400);
        slotSound.freeSpinsWon();
        setOverlay({
          kind: "intro",
          special: result.feature.special,
          spins: result.freeSpinsWon,
          retrigger: result.free,
        });
      } else if (result.featureEnded !== null) {
        await wait(1200);
        setOverlay({
          kind: "summary",
          total: result.featureEnded,
          capped: result.capped,
        });
      }
      if (!result.free && auto && auto.stopAt > 0 && result.win >= result.spin.bet * auto.stopAt) setAuto(null);
    } catch (err) {
      if (landing) {
        reels.current?.land(grid);
        await landing.catch(() => undefined);
      }
      setAuto(null);
      toast.error(err instanceof Error ? ts(err.message) : t("The spin didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setSpinning(false);
    }
  }

  async function guess(pick: CardColor) {
    if (!gamble || guessing) return;
    slotSound.unlock();
    setGuessing(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const path = "/casino/gamble";
      const body = JSON.stringify({ pick });
      const result = await apiFetch<CasinoGambleResult>(path, token, {
        method: "POST",
        body,
        idempotencyKey: gambleKey.keyFor(path, body),
      });
      gambleKey.done();
      setCard({ suit: result.suit, won: result.won, win: result.win });
      slotSound.cardFlip();
      if (result.won) slotSound.gambleWin();
      else slotSound.gambleLose();
      setGamble(result.gamble);
      setBalance(result.balance);
      setLastWin((current) => (current ? { ...current, amount: result.win } : { amount: result.win, big: false }));
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
    setCard(null);
    try {
      const token = await getToken();
      if (token)
        await apiFetch(`/casino/collect`, token, {
          method: "POST",
          body: "{}",
        });
    } catch {
      // The win is already in the balance, and the next spin ends double or nothing anyway.
    }
  }

  // Free spins play by themselves, one after another, once the book has shown its symbol.
  useEffect(() => {
    if (!feature || spinning || overlay || !state || state.closed || !(reelsReady || plainGrid)) return;
    const timer = setTimeout(() => void spin(), lastWin ? 1800 : 700);
    return () => clearTimeout(timer);
    // spin() is a new function every render; the values it reads are listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature, spinning, overlay, state, reelsReady, plainGrid, lastWin]);

  // Autoplay: the next paid spin a moment after the last one lands, until its count runs out.
  useEffect(() => {
    if (!auto || feature || spinning || overlay || !state || !grid) return;
    const affordable = (state.maxStake === null || bet <= state.maxStake) && bet <= balance;
    if (auto.left <= 0 || state.closed || !affordable || !(reelsReady || plainGrid)) {
      setAuto(null);
      return;
    }
    const timer = setTimeout(() => void spin(), lastWin ? 1600 : 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, feature, spinning, overlay, state, grid, bet, balance, reelsReady, plainGrid, lastWin]);

  /** Shows the wins on the reels over and over: all together, then each line in turn. `onRound` runs once every one has been shown. */
  function showAll(won: Combo[], onRound?: () => void) {
    setPinned(null);
    if (won.length === 0) {
      onRound?.();
      return;
    }
    if (won.length === 1) {
      reels.current?.present([won[0].reel], () => setShowing(0), onRound);
      return;
    }
    reels.current?.present([overview(won), ...won.map((combo) => combo.reel)], (index) => setShowing(index === 0 ? null : index - 1), onRound);
  }

  function pick(index: number) {
    // Picking a win ends the first showing of them all; double or nothing comes up now.
    setGambleShown(true);
    if (pinned === index) {
      showAll(combos);
      return;
    }
    setPinned(index);
    setShowing(index);
    reels.current?.present([combos[index].reel], () => setShowing(index));
  }

  useGameKeys(rulesOpen);

  if (!state || !grid || !artReady) return <PageLoading label="Loading the Casino" />;
  const playingFree = feature !== null;
  const tooBig = (value: number) => (state.maxStake !== null && value > state.maxStake) || value > balance;
  const winCells = new Set(combos.flatMap((combo, index) => (showing === null || showing === index ? combo.reel.cells.map((cell) => cell.join(":")) : [])));
  // Double or nothing, offered after a win, is settled before the next spin: guessed, or the win taken. Autoplay skips it.
  const gambleOpen = !auto && !playingFree && (gamble !== null || card !== null);
  const canSpin = !state.closed && !spinning && !overlay && !gambleOpen && (reelsReady || plainGrid) && !playingFree && !tooBig(bet);
  const allowedBets = state.game.bets.filter((value) => state.maxStake === null || value <= state.maxStake);
  const chooseBet = (value: number) => {
    slotSound.unlock();
    slotSound.click();
    setBet(value);
    setBetMenu(false);
  };
  const maxBet = () => {
    slotSound.unlock();
    slotSound.click();
    const affordable = allowedBets.filter((value) => value <= balance);
    setBet(affordable[affordable.length - 1] ?? allowedBets[0] ?? bet);
  };
  const litLines = new Set(
    combos.flatMap((combo, index) =>
      showing === null || showing === index
        ? combo.kind === "expanded"
          ? state.game.lineShapes.map((_, line) => line)
          : combo.line !== null
            ? [combo.line - 1]
            : []
        : [],
    ),
  );
  const message = spinning
    ? playingFree
      ? t("Free spin {number} of {total}", {
          number: feature.played + 1,
          total: feature.played + feature.remaining,
        })
      : t("Good luck!")
    : card
      ? card.won
        ? t("Win {amount}", { amount: formatMoney(card.win) })
        : t("Better luck next time")
      : lastWin
        ? t("Win {amount}", { amount: formatMoney(countedWin) })
        : playingFree
          ? tn(feature.remaining, "{count} free spin left", "{count} free spins left")
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
          <p className="muted report-subtitle">{t("5 reels, 10 lines, and the book that opens free spins. Played with your balance.")}</p>
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

          <section
            ref={cabinet}
            className={`slot-cabinet is-book${playingFree ? " is-free" : ""}${fullScreen !== "off" ? " is-full" : ""}`}
            aria-label={state.game.name}
          >
            <header className="slot-marquee book-marquee">
              <BookMarquee />
              <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
                ‹
              </Link>
              <h2 className="sr-only">{state.game.name}</h2>
              {playingFree ? (
                <span className="book-free-banner" aria-live="polite">
                  <span>{t("Free spins")}</span>
                  <b>
                    {feature.played} / {feature.played + feature.remaining}
                  </b>
                  <span className="book-special">
                    {t("Special symbol")}
                    <SymbolPicture symbol={feature.special} alt={t(SYMBOL_NAMES[feature.special])} />
                  </span>
                  <span>
                    {t("Won so far: {amount}", {
                      amount: formatMoney(feature.won),
                    })}
                  </span>
                </span>
              ) : null}
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

            <div className="book-hall" ref={hallLayout.hall}>
              <BookTempleDefs />
              <BookWall />
              <BookColumn side="left" />
              <BookColumn side="right" />
              <div className="slot-stage">
                <BookMarkers side="left" lit={litLines} />
                <div ref={hallLayout.reels} className={`casino-window${lastWin?.big ? " is-big-win" : ""}`}>
                  <ReelBackdrop reels={state.game.reels} rows={state.game.rows} />
                  {lastWin?.big && !overlay ? (
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
                      scatter={state.game.book}
                      weights={SPIN_WEIGHTS}
                      draw={drawBookSymbol}
                      instant={instant}
                      onReady={() => setReelsReady(true)}
                      onFailed={() => setPlainGrid(true)}
                    />
                  )}
                  {!reelsReady && !plainGrid ? <LoadingSpinner label="Setting up the reels" /> : null}

                  {overlay?.kind === "intro" ? (
                    <BookIntro overlay={overlay} paying={state.game.paying} instant={instant} onStart={() => setOverlay(null)} />
                  ) : overlay?.kind === "summary" ? (
                    <div className="book-overlay" role="dialog" aria-live="polite">
                      <div className="book-summary">
                        <span>{t("Free spins over")}</span>
                        <strong>{formatMoney(overlay.total)}</strong>
                        {overlay.capped ? (
                          <small>{t("That's the most a round can pay: {times} times the bet.", { times: state.game.maxWin.toLocaleString() })}</small>
                        ) : null}
                        <button type="button" className="slot-btn slot-start" onClick={() => setOverlay(null)}>
                          {t("Continue")}
                        </button>
                      </div>
                    </div>
                  ) : ((gamble && !auto && !playingFree) || card) && gambleShown ? (
                    <GamblePanel
                      gamble={gamble}
                      card={card}
                      cardKey={recent[0]?.id}
                      guessing={guessing}
                      onGuess={guess}
                      onTake={takeWin}
                      onContinue={() => setCard(null)}
                    />
                  ) : null}
                </div>
                <BookMarkers side="right" lit={litLines} />
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
                <div className={`slot-message${lastWin || card?.won ? " is-win" : ""}`} aria-live="polite">
                  <span>{message}</span>
                  <small>
                    {t("Credits")}: {formatMoney(balance)}
                  </small>
                </div>
                <button type="button" className="slot-btn" onClick={maxBet} disabled={spinning || auto !== null || playingFree}>
                  {t("Max bet")}
                </button>
                <div className="book-auto">
                  <button
                    type="button"
                    className={`slot-btn slot-auto${auto ? " is-on" : ""}`}
                    aria-pressed={auto !== null}
                    aria-expanded={autoMenu}
                    onClick={() => (auto ? setAuto(null) : setAutoMenu((open) => !open))}
                    disabled={!auto && !canSpin}
                  >
                    <small>{auto ? t("{count} left", { count: auto.left }) : t("Auto")}</small>
                    <span className="slot-switch" aria-hidden="true" />
                  </button>
                  {autoMenu && !auto ? (
                    <div className="book-auto-menu" role="dialog" aria-label={t("Autoplay")}>
                      <strong>{t("Autoplay")}</strong>
                      <span className="muted">
                        {t("Spins in a row at {amount}. It stops for free spins, when your balance or a limit runs out, or when you leave the page.", {
                          amount: formatMoney(bet),
                        })}
                      </span>
                      <label>
                        {t("Stop on a win of")}
                        <select value={autoStopAt} onChange={(event) => setAutoStopAt(Number(event.target.value))}>
                          {AUTO_STOPS.map((times) => (
                            <option key={times} value={times}>
                              {times === 0 ? t("Don't stop on a win") : t("{times}× the bet or more", { times })}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="book-auto-counts">
                        {AUTO_COUNTS.map((count) => (
                          <button
                            key={count}
                            type="button"
                            className="slot-btn"
                            onClick={() => {
                              slotSound.unlock();
                              setAutoMenu(false);
                              setAuto({ left: count, stopAt: autoStopAt });
                            }}
                          >
                            {count}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </footer>

              {/* START and TOTAL BET: rings over the right-hand numbers, as in the original. */}
              <div className="book-rings">
                <div className="book-ring-spot is-start">
                  <button type="button" className="book-ring is-start" data-key="Space" onClick={() => (auto ? setAuto(null) : spinning ? reels.current?.skip() : spin())} disabled={!auto && !spinning && !canSpin}>
                    <StartArrows />
                    <span>{auto ? t("Stop") : playingFree ? t("Free spin") : t("Start")}</span>
                  </button>
                </div>
                <div className="book-ring-spot is-bet">
                  <button
                    type="button"
                    className="book-ring is-bet"
                    aria-expanded={betMenu}
                    aria-label={`${t("Change the bet")}: ${formatMoney(playingFree ? feature.bet : bet)}`}
                    onClick={() => setBetMenu((open) => !open)}
                    disabled={spinning || auto !== null || playingFree}
                  >
                    <small>{t("Total bet")}</small>
                    <b>{formatMoney(playingFree ? feature.bet : bet)}</b>
                  </button>
                  {betMenu && !spinning && !auto && !playingFree ? (
                    <div className="book-auto-menu book-bet-menu" role="dialog" aria-label={t("Total bet")}>
                      <strong>{t("Total bet")}</strong>
                      <div className="book-auto-counts">
                        {allowedBets.map((value) => (
                          <button
                            key={value}
                            type="button"
                            className={`slot-btn${value === bet ? " is-on" : ""}`}
                            aria-pressed={value === bet}
                            disabled={value > balance}
                            onClick={() => chooseBet(value)}
                          >
                            {formatMoney(value)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {rulesOpen && fullScreen !== "off" ? (
              <Rules game={state.game} bet={playingFree ? feature.bet : bet} onClose={() => setRulesOpen(false)} i18n={i18n} />
            ) : null}
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
                  <span className="casino-combo-name">
                    {combo.kind === "line"
                      ? t("Line {number}", { number: combo.line! })
                      : combo.kind === "books"
                        ? t(SYMBOL_NAMES.BOOK)
                        : t("Special symbol, every line")}
                  </span>
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
          <HelpTip text="Your newest Book of Ra spins, free ones included. They're also in My money, as one Book of Ra line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {t("No spins yet.")}
          </p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <div className="report-list-row" key={row.id}>
                <div>
                  <strong>
                    {row.free
                      ? t("Free spin at {amount}", {
                          amount: formatMoney(row.bet),
                        })
                      : t("Spin at {amount}", { amount: formatMoney(row.bet) })}
                  </strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)}
                    {row.freeSpinsWon > 0 ? ` · ${tn(row.freeSpinsWon, "{count} free spin won", "{count} free spins won")}` : ""}
                  </span>
                </div>
                <strong className={row.win > 0 ? "money-amount is-in" : "muted"}>{row.win > 0 ? `+${formatMoney(row.win)}` : t("No win")}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen && fullScreen === "off" ? (
        <Rules game={state.game} bet={playingFree ? feature.bet : bet} onClose={() => setRulesOpen(false)} i18n={i18n} />
      ) : null}
    </div>
  );
}

/**
 * Free spins won: the book opens and its pages flip through the symbols,
 * stopping on the special one. The free spins start when the Player taps,
 * or by themselves after a few seconds.
 */
function BookIntro({
  overlay,
  paying,
  instant,
  onStart,
}: {
  overlay: Extract<Overlay, { kind: "intro" }>;
  paying: BookPaying[];
  instant: boolean;
  onStart(): void;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<BookPaying>(instant ? overlay.special : paying[0]);
  const [chosen, setChosen] = useState(instant || overlay.retrigger);
  // The page re-renders while a win counts up; the timer below mustn't restart each time.
  const start = useRef(onStart);
  start.current = onStart;

  useEffect(() => {
    if (instant || overlay.retrigger) return;
    slotSound.pageFlip(14);
    let flips = 0;
    const timer = setInterval(() => {
      flips += 1;
      if (flips >= 14) {
        clearInterval(timer);
        setPage(overlay.special);
        setChosen(true);
        slotSound.gong();
        return;
      }
      setPage(paying[flips % paying.length]);
    }, 110);
    return () => clearInterval(timer);
  }, [instant, overlay, paying]);

  // Starts by itself a few seconds after the symbol shows.
  useEffect(() => {
    if (!chosen) return;
    const timer = setTimeout(() => start.current(), overlay.retrigger ? 2500 : 4000);
    return () => clearTimeout(timer);
  }, [chosen, overlay.retrigger]);

  return (
    <div className="book-overlay" role="dialog" aria-live="polite" aria-label={t("Free spins")}>
      <div className="book-intro">
        <strong>{overlay.retrigger ? t("{count} more free spins!", { count: overlay.spins }) : t("{count} free spins!", { count: overlay.spins })}</strong>
        <div className={`book-open${chosen ? " is-chosen" : ""}`}>
          <span className="book-page is-left" />
          <span className="book-page is-right">
            <SymbolPicture symbol={page} alt={chosen ? t(SYMBOL_NAMES[page]) : ""} />
          </span>
        </div>
        {chosen ? (
          <span>{t("Special symbol: {name}. In each free spin it fills its reels and pays on all 10 lines.", { name: t(SYMBOL_NAMES[overlay.special]) })}</span>
        ) : (
          <span className="muted">{t("The book is choosing your special symbol…")}</span>
        )}
        <button type="button" className="slot-btn slot-start" onClick={onStart} disabled={!chosen}>
          {t("Start free spins")}
        </button>
      </div>
    </div>
  );
}

/** The numbered boxes beside the reels, one per line in the original's order and colours; lit while their line shows. */
function BookMarkers({ side, lit }: { side: "left" | "right"; lit: Set<number> }) {
  return (
    <div className={`book-markers is-${side}`} aria-hidden="true">
      {MARKERS[side].map((line) => (
        <span key={line} className={`book-marker${lit.has(line - 1) ? " is-lit" : ""}`} style={{ "--marker": LINE_COLORS[line - 1] } as CSSProperties}>
          {line}
        </span>
      ))}
    </div>
  );
}

/** A symbol's picture. It's drawn in the browser, so there's nothing for next/image to optimise. */
function SymbolPicture({ symbol, alt }: { symbol: BookSymbol; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={bookSymbolImage(symbol)} alt={alt} />;
}

/** When the reels can't be drawn (no WebGL): the same result as plain pictures. */
function PlainGrid({ grid, lit }: { grid: BookSymbol[][]; lit: Set<string> | null }) {
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

function Rules({ game, bet, onClose, i18n }: { game: BookState["game"]; bet: number; onClose: () => void; i18n: I18n }) {
  const { t } = i18n;
  const lineBet = bet / game.lines;
  const money = (lineBets: number) => formatMoney(Math.floor(lineBets * lineBet * 100 + 1e-6) / 100);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="book-rules-title">
        <div className="modal-header">
          <h2 id="book-rules-title">{t("Pays and rules")}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            "Pays shown for a {amount} spin. A line pays when the same symbol lands on it from the left reel: the explorer, pharaoh, statue and scarab from 2 in a row, the cards from 3.",
            { amount: formatMoney(bet) },
          )}
        </p>
        <div className="casino-paytable">
          <div className="casino-pay">
            <SymbolPicture symbol={game.book} alt="" />
            <span>{t(SYMBOL_NAMES.BOOK)}</span>
            <span className="casino-pay-amounts">
              {(["3", "4", "5"] as const).map((count) => (
                <span key={count}>
                  <b>{count}×</b> {formatMoney(game.scatterPays[count] * bet)}
                </span>
              ))}
            </span>
          </div>
          {game.paying.map((symbol) => (
            <div key={symbol} className="casino-pay">
              <SymbolPicture symbol={symbol} alt="" />
              <span>{t(SYMBOL_NAMES[symbol])}</span>
              <span className="casino-pay-amounts">
                {game.linePays[symbol].map((pay, index) =>
                  pay > 0 ? (
                    <span key={index}>
                      <b>{index + 2}×</b> {money(pay)}
                    </span>
                  ) : null,
                )}
              </span>
            </div>
          ))}
        </div>
        <div className="stack-tight">
          <strong>{t("The book")}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "The book stands in for any symbol on a line, and pays anywhere on the reels: 3, 4 or 5 books pay 2, 20 or 200 times the bet, and 3 or more give {count} free spins.",
              { count: game.freeSpins },
            )}
          </p>
        </div>
        <div className="stack-tight">
          <strong>{t("Free spins and the special symbol")}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "Before the free spins the book chooses a special symbol. In each free spin, after the line wins are paid, the special symbol on enough reels fills them and pays again on all 10 lines. The reels don't need to be next to each other. 3 books in a free spin give {count} more.",
              { count: game.freeSpins },
            )}
          </p>
        </div>
        <div className="stack-tight">
          <strong>{t("The 10 lines")}</strong>
          <div className="casino-lines">
            {game.lineShapes.map((shape, index) => (
              <svg key={index} viewBox={`0 0 ${game.reels * 10} ${game.rows * 10}`} role="img" aria-label={t("Line {number}", { number: index + 1 })}>
                {Array.from({ length: game.reels * game.rows }, (_, cell) => {
                  const reel = cell % game.reels;
                  const row = Math.floor(cell / game.reels);
                  return (
                    <rect key={cell} x={reel * 10 + 1} y={row * 10 + 1} width="8" height="8" rx="1.5" className={shape[reel] === row ? "is-on" : undefined} />
                  );
                })}
              </svg>
            ))}
          </div>
        </div>
        <div className="stack-tight">
          <strong>{t("Double or nothing")}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {t(
              "After a win, or at the end of the free spins, you can guess whether a card is red or black. Right, and the win doubles; wrong, and it's lost. Up to {steps} guesses in a row, and up to {limit}.",
              {
                steps: game.gambleSteps,
                limit: formatMoney(game.gambleLimit),
              },
            )}
          </p>
        </div>
        <p style={{ margin: 0 }}>
          {t("A spin, or a round of free spins with the spin that started it, pays at most {times} times the bet.", { times: game.maxWin.toLocaleString() })}
        </p>
      </section>
    </div>
  );
}
