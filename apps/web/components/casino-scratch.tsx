"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { SeedLine, Sheet, ShieldIcon } from "./fair-play";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { apiFetch, newIdempotencyKey, type DiceSeed, type DiceSeedChange, type ScratchBuyResult, type ScratchCard, type ScratchState, type ScratchSymbol } from "../lib/api";
import { sha256Hex } from "../lib/dice";
import { formatMoney, formatStake } from "../lib/format";
import { CELLS, SYMBOL_ART, SYMBOL_NAMES, cardFromSeeds } from "../lib/scratch";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

/** Reveal all: the pause between boxes. Autoplay's is quicker. */
const REVEAL_GAP_MS = 110;
const AUTO_REVEAL_GAP_MS = 45;
/** The pause after an autoplay card, to see what it won. */
const AUTO_GAP_MS = 380;
/** A box counts as scratched once this share of it is clear; the rest of its foil then falls away. */
const CLEAR_SHARE = 0.45;
/** Each box is checked for scratching on a grid this fine. */
const MASK = 8;

type Verify = { serverSeed: string; clientSeed: string; nonce: string };
type Rect = { x: number; y: number; w: number; h: number };

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const allShown = () => Array<boolean>(CELLS).fill(true);
const noneShown = () => Array<boolean>(CELLS).fill(false);
const emptyMask = () => Array.from({ length: CELLS }, () => Array<boolean>(MASK * MASK).fill(false));
/** ALL typed by the Player, or NaN. Whole cents only. */
function parseMoney(text: string): number {
  const value = Number(text.replace(",", ".").replace(/[$\s]/g, ""));
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? Math.round(value * 100) / 100 : Number.NaN;
}

function SymbolArt({ symbol }: { symbol: ScratchSymbol }) {
  return symbol === "SEVEN" ? <span className="scratch-seven">7</span> : <span className="scratch-emoji">{SYMBOL_ART[symbol]}</span>;
}

/** A card's 9 boxes, small, for the history and the checks. */
function MiniCard({ cells, symbol }: { cells: ScratchSymbol[]; symbol: ScratchSymbol | null }) {
  return (
    <div className="scratch-mini" aria-hidden="true">
      {cells.map((cell, index) => (
        <span key={index} className={symbol && cell === symbol ? "is-win" : undefined}>
          <SymbolArt symbol={cell} />
        </span>
      ))}
    </div>
  );
}

/** Scratch Cards for a Player: buy a card, scratch its 9 boxes, and check every card from its seeds. */
export function ScratchGame() {
  const { getToken } = useAuth();
  const { t, ts, date } = useI18n();
  const toast = useToast();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<ScratchState | null>(null);
  const [balance, setBalance] = useState(0);
  const [stake, setStake] = useState(100);
  const [recent, setRecent] = useState<ScratchCard[]>([]);
  const [seed, setSeed] = useState<DiceSeed | null>(null);
  const [previousSeed, setPreviousSeed] = useState<DiceSeed | null>(null);
  /** The card on the table, and which of its boxes are scratched. Settled once every box shows and its win is counted. */
  const [card, setCard] = useState<ScratchCard | null>(null);
  const [revealed, setRevealed] = useState<boolean[]>(allShown);
  const [settled, setSettled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [autoCount, setAutoCount] = useState("10");
  const [stopProfit, setStopProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [auto, setAuto] = useState<{ done: number; total: number | null; profit: number } | null>(null);
  /** This visit's cards and profit. */
  const [visit, setVisit] = useState({ cards: 0, profit: 0, wins: 0 });
  const [sheet, setSheet] = useState<"rules" | "fair" | null>(null);
  const [detail, setDetail] = useState<ScratchCard | null>(null);
  const [newClientSeed, setNewClientSeed] = useState("");
  const [changingSeed, setChangingSeed] = useState(false);
  const [verify, setVerify] = useState<Verify>({ serverSeed: "", clientSeed: "", nonce: "0" });
  const [verified, setVerified] = useState<{ cells: ScratchSymbol[] | null; symbol: ScratchSymbol | null; hash: string } | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const balanceRef = useRef(0);
  balanceRef.current = balance;
  const areaRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cellRects = useRef<Rect[]>([]);
  const revealedRef = useRef<boolean[]>(allShown());
  const settledRef = useRef(true);
  const cardRef = useRef<ScratchCard | null>(null);
  const mask = useRef(emptyMask());
  /** The bought card's answer, counted once every box shows. */
  const pending = useRef<ScratchBuyResult | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const lastScratchSound = useRef(0);
  const autoStop = useRef(false);
  const reducedMotion = useRef(false);

  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => {
    reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return () => {
      autoStop.current = true;
    };
  }, []);

  /** Clears one box's foil. */
  const clearCell = useCallback((index: number) => {
    const context = canvasRef.current?.getContext("2d");
    const rect = cellRects.current[index];
    if (!context || !rect) return;
    context.clearRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
  }, []);

  /** Lays silver foil over the card, a "?" on each box, and clears the boxes already scratched. */
  const paintFoil = useCallback(() => {
    const canvas = canvasRef.current;
    const area = areaRef.current;
    if (!canvas || !area) return;
    const bounds = area.getBoundingClientRect();
    if (bounds.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    cellRects.current = Array.from(area.querySelectorAll<HTMLElement>(".scratch-cell")).map((cell) => {
      const box = cell.getBoundingClientRect();
      return { x: box.left - bounds.left, y: box.top - bounds.top, w: box.width, h: box.height };
    });
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalCompositeOperation = "source-over";
    const { width, height } = bounds;
    const silver = context.createLinearGradient(0, 0, width, height);
    silver.addColorStop(0, "#b9c0ca");
    silver.addColorStop(0.35, "#eef1f5");
    silver.addColorStop(0.6, "#c3cad4");
    silver.addColorStop(1, "#9aa3b0");
    context.fillStyle = silver;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.lineWidth = 5;
    for (let x = -height; x < width; x += 16) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + height, height);
      context.stroke();
    }
    for (const rect of cellRects.current) {
      context.fillStyle = "rgba(60, 68, 82, 0.08)";
      context.strokeStyle = "rgba(255, 255, 255, 0.5)";
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(rect.x + 3, rect.y + 3, rect.w - 6, rect.h - 6, 10);
      context.fill();
      context.stroke();
      context.fillStyle = "rgba(70, 78, 92, 0.42)";
      context.font = `900 ${Math.round(rect.h * 0.42)}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("?", rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
    }
    revealedRef.current.forEach((shown, index) => shown && clearCell(index));
  }, [clearCell]);

  /** Counts the card's win once every box shows: the balance, the history, this visit, and the sound. */
  const settle = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    setSettled(true);
    const answer = pending.current;
    pending.current = null;
    if (answer) {
      const { round } = answer;
      setBalance(answer.balance);
      setSeed(answer.seed);
      setRecent((rows) => [round, ...rows].slice(0, 20));
      setVisit((current) => ({ cards: current.cards + 1, wins: current.wins + (round.multiplier > 0 ? 1 : 0), profit: Math.round((current.profit + round.win - round.bet) * 100) / 100 }));
      slotSound.scratchResult(round.multiplier);
    }
  }, []);

  /** Shows one box: clears its foil, and settles the card once it's the last. */
  const revealCell = useCallback(
    (index: number) => {
      if (revealedRef.current[index]) return;
      revealedRef.current = revealedRef.current.map((shown, i) => shown || i === index);
      setRevealed(revealedRef.current);
      clearCell(index);
      slotSound.scratchReveal(revealedRef.current.filter(Boolean).length);
      if (revealedRef.current.every(Boolean)) settle();
    },
    [clearCell, settle],
  );

  /** Shows every box still covered, one after another. Resolves once the card is settled. */
  const revealAll = useCallback(
    async (gap: number) => {
      const target = cardRef.current;
      for (let index = 0; index < CELLS; index++) {
        if (cardRef.current !== target || settledRef.current) break;
        if (revealedRef.current[index]) continue;
        revealCell(index);
        if (gap > 0 && !document.hidden && !reducedMotion.current) await sleep(gap);
      }
    },
    [revealCell],
  );

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<ScratchState>("/casino/scratch", token);
    setState(next);
    setBalance(next.balance);
    setRecent(next.recent);
    setSeed(next.seed);
    setPreviousSeed(next.previousSeed);
    setNewClientSeed(next.seed.clientSeed);
    // Keep the price if it's still one of the bets within the Player's max stake; otherwise the biggest that is.
    const allowed = next.game.bets.filter((value) => value <= next.tableMax);
    setStake((current) => (allowed.includes(current) ? current : (allowed.filter((value) => value <= current).pop() ?? allowed[0] ?? next.game.bets[0])));
    // The last card shows scratched; with none yet, a covered card waits.
    cardRef.current = next.recent[0] ?? null;
    setCard(cardRef.current);
    revealedRef.current = cardRef.current ? allShown() : noneShown();
    setRevealed(revealedRef.current);
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The foil, painted once the card is on the page, and again when its size changes.
  const ready = state !== null && !state.closed;
  useEffect(() => {
    if (!ready) return;
    paintFoil();
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === "undefined") return;
    let width = area.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = area.getBoundingClientRect().width;
      if (Math.abs(next - width) < 1) return;
      width = next;
      paintFoil();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [ready, paintFoil, fullScreen]);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy && !auto && settledRef.current) setBalance(event.balance);
  });

  const stakeProblem = (() => {
    if (!state) return null;
    if (stake > state.tableMax) return t("The most a card can cost you is {amount}.", { amount: formatMoney(state.tableMax) });
    if (stake > balance) return t("Your balance is too low for this stake.");
    return null;
  })();
  const locked = busy || auto !== null;
  const scratchable = !!card && !settled;

  /** Buys one card at the price on the table and lays it out covered. Returns the answer, or null if it didn't go through. */
  const buyOnce = useCallback(async (): Promise<ScratchBuyResult | null> => {
    if (!state || state.closed) return null;
    if (stake > state.tableMax || stake > balanceRef.current + 1e-9) {
      if (stakeProblem) toast.error(stakeProblem);
      return null;
    }
    slotSound.unlock();
    slotSound.ticket();
    let response: ScratchBuyResult;
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      response = await apiFetch<ScratchBuyResult>("/casino/scratch/buy", token, { method: "POST", body: JSON.stringify({ bet: stake }), idempotencyKey: newIdempotencyKey() });
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
      return null;
    }
    // The price leaves straight away; the win arrives once the card is scratched.
    setBalance(Math.round((balanceRef.current - response.round.bet) * 100) / 100);
    pending.current = response;
    cardRef.current = response.round;
    settledRef.current = false;
    revealedRef.current = noneShown();
    mask.current = emptyMask();
    setSettled(false);
    setRevealed(revealedRef.current);
    setCard(response.round);
    paintFoil();
    return response;
  }, [state, stake, stakeProblem, getToken, t, ts, toast, paintFoil]);

  async function buyManual() {
    if (locked) return;
    setBusy(true);
    try {
      await buyOnce();
    } finally {
      setBusy(false);
    }
  }

  async function startAuto() {
    if (locked || !state) return;
    const count = autoCount.trim() === "" || Number(autoCount) === 0 ? null : Math.floor(Number(autoCount));
    if (count !== null && (!Number.isFinite(count) || count < 1 || count > 1000)) {
      toast.error(t("Set from 1 to 1,000 cards, or 0 to keep going until you stop."));
      return;
    }
    const profitLimit = stopProfit.trim() ? parseMoney(stopProfit) : null;
    const lossLimit = stopLoss.trim() ? parseMoney(stopLoss) : null;
    if ((profitLimit !== null && !(profitLimit > 0)) || (lossLimit !== null && !(lossLimit > 0))) {
      toast.error(t("Stop on profit and stop on loss are amounts above 0 ALL, or empty."));
      return;
    }
    // A card still covered is shown first.
    if (!settledRef.current) await revealAll(0);
    autoStop.current = false;
    let done = 0;
    let profit = 0;
    setAuto({ done, total: count, profit });
    while (!autoStop.current && (count === null || done < count)) {
      const response = await buyOnce();
      if (!response) break;
      await revealAll(AUTO_REVEAL_GAP_MS);
      done += 1;
      profit = Math.round((profit + response.round.win - response.round.bet) * 100) / 100;
      setAuto({ done, total: count, profit });
      if (profitLimit !== null && profit >= profitLimit) {
        toast.success(t("Autoplay stopped: profit reached {amount}.", { amount: formatMoney(profit) }));
        break;
      }
      if (lossLimit !== null && -profit >= lossLimit) {
        toast.info(t("Autoplay stopped: loss reached {amount}.", { amount: formatMoney(-profit) }));
        break;
      }
      await sleep(reducedMotion.current ? 80 : AUTO_GAP_MS);
    }
    setAuto(null);
  }

  // Space presses the main button on a computer: reveal the card, buy the next, or start and stop autoplay. Not while typing or with a sheet open.
  const mainAction = useRef<() => void>(() => undefined);
  mainAction.current = () => {
    if (mode === "manual") {
      if (!settledRef.current) void revealAll(REVEAL_GAP_MS);
      else void buyManual();
    } else if (auto) autoStop.current = true;
    else void startAuto();
  };
  const sheetOpen = sheet !== null || detail !== null;
  const sheetOpenRef = useRef(sheetOpen);
  sheetOpenRef.current = sheetOpen;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (sheetOpenRef.current) return;
      event.preventDefault();
      if (event.type !== "keydown" || event.repeat) return;
      mainAction.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  /** Scratches from one point to the next: clears the foil under the coin, and shows each box once enough of it is clear. */
  const scratchTo = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const context = canvasRef.current?.getContext("2d");
      const rects = cellRects.current;
      if (!context || rects.length === 0) return;
      const brush = Math.max(12, rects[0].w * 0.2);
      context.globalCompositeOperation = "destination-out";
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = brush * 2;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x + 0.01, to.y);
      context.stroke();
      context.globalCompositeOperation = "source-over";

      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.max(1, Math.ceil(length / (brush / 2)));
      for (let step = 0; step <= steps; step++) {
        const x = from.x + ((to.x - from.x) * step) / steps;
        const y = from.y + ((to.y - from.y) * step) / steps;
        rects.forEach((rect, index) => {
          if (revealedRef.current[index]) return;
          if (x < rect.x - brush || x > rect.x + rect.w + brush || y < rect.y - brush || y > rect.y + rect.h + brush) return;
          const cells = mask.current[index];
          for (let row = 0; row < MASK; row++) {
            for (let column = 0; column < MASK; column++) {
              const cx = rect.x + ((column + 0.5) * rect.w) / MASK;
              const cy = rect.y + ((row + 0.5) * rect.h) / MASK;
              if (Math.hypot(cx - x, cy - y) <= brush) cells[row * MASK + column] = true;
            }
          }
        });
      }
      mask.current.forEach((cells, index) => {
        if (!revealedRef.current[index] && cells.filter(Boolean).length / cells.length >= CLEAR_SHARE) revealCell(index);
      });
    },
    [revealCell],
  );

  const pointOf = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (settledRef.current || auto) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    slotSound.unlock();
    const point = pointOf(event);
    lastPoint.current = point;
    scratchTo(point, point);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!lastPoint.current || settledRef.current) return;
    const point = pointOf(event);
    scratchTo(lastPoint.current, point);
    lastPoint.current = point;
    const now = performance.now();
    if (now - lastScratchSound.current > 70) {
      lastScratchSound.current = now;
      slotSound.scratch();
    }
  }

  function onPointerUp() {
    lastPoint.current = null;
  }

  // The seed check, worked out in the browser as the Player types.
  useEffect(() => {
    let current = true;
    const nonce = Number(verify.nonce);
    if (!verify.serverSeed) {
      setVerified(null);
      return;
    }
    (async () => {
      const hash = await sha256Hex(verify.serverSeed);
      const made = verify.clientSeed && Number.isInteger(nonce) && nonce >= 0 ? await cardFromSeeds(verify.serverSeed, verify.clientSeed, nonce) : null;
      if (current) setVerified({ cells: made?.cells ?? null, symbol: made?.symbol ?? null, hash });
    })().catch(() => current && setVerified(null));
    return () => {
      current = false;
    };
  }, [verify]);

  async function changeSeed() {
    if (locked || changingSeed) return;
    const clientSeed = newClientSeed.trim();
    if (clientSeed && !/^[A-Za-z0-9_-]{1,32}$/.test(clientSeed)) {
      toast.error(t("A client seed is 1 to 32 letters, digits, dashes or underscores."));
      return;
    }
    setChangingSeed(true);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      const change = await apiFetch<DiceSeedChange>("/casino/scratch/seed", token, { method: "POST", body: JSON.stringify(clientSeed ? { clientSeed } : {}) });
      setSeed(change.seed);
      setPreviousSeed(change.previousSeed);
      setNewClientSeed(change.seed.clientSeed);
      // Cards made with the old pair can be checked now.
      const revealedHash = change.previousSeed.serverSeedHash;
      setRecent((rows) => rows.map((row) => (row.serverSeedHash === revealedHash ? { ...row, serverSeed: change.previousSeed.serverSeed } : row)));
      toast.success(t("New seeds set. The old server seed is shown below."));
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("Couldn't change it"));
    } finally {
      setChangingSeed(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(t("Copied.")),
      () => undefined,
    );
  }

  if (!state || !seed) return <PageLoading label="Loading the Casino" />;

  const symbolName = (symbol: ScratchSymbol) => t(SYMBOL_NAMES[symbol]);
  const outcome = card && settled ? (card.multiplier > 0 ? " is-win" : " is-loss") : "";
  const prizes = [...state.game.prizes].reverse();

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Scratch Cards")}</h1>
          <p className="muted report-subtitle">{t("Buy a card and scratch it. Three of a kind wins. Every card can be checked. Played with your balance.")}</p>
        </div>
        <div className="dice-title-actions">
          <button type="button" className="secondary" onClick={() => setSheet("fair")}>
            {t("Provably fair")}
          </button>
          <button type="button" className="secondary" onClick={() => setSheet("rules")}>
            {t("Pays and rules")}
          </button>
        </div>
      </div>

      {state.closed ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <section ref={cabinet} className={`dice-cabinet scratch-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={t("Scratch Cards")}>
          <header className="slot-marquee dice-marquee scratch-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">{t("Scratch Cards")}</span>
            <button type="button" className="slot-fullscreen dice-fair-button" onClick={() => setSheet("fair")} aria-label={t("Provably fair")} title={t("Provably fair")}>
              <ShieldIcon />
            </button>
            <button
              type="button"
              className="slot-fullscreen dice-sound"
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
            <button type="button" className="slot-fullscreen dice-rules" onClick={() => setSheet("rules")} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
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

          <div className="dice-body">
            <div className="dice-stage scratch-stage">
              <div className="dice-readout">
                <span>
                  <small>{t("Balance")}</small>
                  <strong>{formatMoney(balance)}</strong>
                </span>
                <span>
                  <small>{t("This visit")}</small>
                  <strong className={visit.profit < 0 ? "is-loss" : visit.profit > 0 ? "is-win" : undefined}>
                    {visit.profit > 0 ? "+" : ""}
                    {formatMoney(visit.profit)}
                  </strong>
                </span>
                <span>
                  <small>{t("Cards won")}</small>
                  <strong>
                    {visit.wins} / {visit.cards}
                  </strong>
                </span>
              </div>

              <div className="dice-history" aria-label={t("Your last cards")}>
                {recent.slice(0, 12).map((row) => (
                  <button type="button" key={row.id} className={`dice-chip${row.multiplier > 1 ? " is-win" : row.multiplier === 1 ? " is-even" : " is-loss"}`} onClick={() => setDetail(row)} title={t("Card details")}>
                    {row.multiplier > 0 ? `${row.multiplier}×` : "—"}
                  </button>
                ))}
              </div>

              <div className={`scratch-ticket${outcome}`}>
                <div className="scratch-ticket-head">
                  <strong>{t("Match 3 to win")}</strong>
                  <span>{formatStake(card && !settled ? card.bet : stake)}</span>
                </div>
                <div className="scratch-area" ref={areaRef}>
                  <div className="scratch-grid">
                    {Array.from({ length: CELLS }, (_, index) => {
                      const symbol = card?.cells[index] ?? null;
                      const winning = !!card && settled && card.symbol !== null && symbol === card.symbol;
                      return (
                        <div key={index} className={`scratch-cell${winning ? " is-win" : ""}${card && settled && card.symbol && !winning ? " is-dim" : ""}`} aria-label={symbol && revealed[index] ? symbolName(symbol) : t("Covered")}>
                          {symbol && revealed[index] ? <SymbolArt symbol={symbol} /> : null}
                        </div>
                      );
                    })}
                  </div>
                  <canvas
                    ref={canvasRef}
                    className={`scratch-foil${scratchable && !auto ? " is-live" : ""}`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    aria-hidden="true"
                  />
                </div>
                <ul className="scratch-legend" aria-label={t("Prizes")}>
                  {prizes.map((prize) => (
                    <li key={prize.symbol} className={card && settled && card.symbol === prize.symbol ? "is-win" : undefined}>
                      <span className="scratch-legend-symbols" aria-label={symbolName(prize.symbol)}>
                        <SymbolArt symbol={prize.symbol} />
                        <SymbolArt symbol={prize.symbol} />
                        <SymbolArt symbol={prize.symbol} />
                      </span>
                      <strong>{formatStake((card && !settled ? card.bet : stake) * prize.multiplier)}</strong>
                    </li>
                  ))}
                </ul>
              </div>

              <span className="dice-result-note scratch-note" aria-live="polite">
                {!card
                  ? t("Buy a card, then scratch the boxes.")
                  : !settled
                    ? t("Scratch the boxes, or reveal them all.")
                    : card.multiplier > 0
                      ? t("3 × {symbol}: you won {amount}", { symbol: symbolName(card.symbol as ScratchSymbol), amount: formatMoney(card.win) })
                      : t("No win this time")}
              </span>
            </div>

            <div className="dice-controls">
              <div className="dice-tabs" role="tablist" aria-label={t("Play")}>
                {(["manual", "auto"] as const).map((value) => (
                  <button key={value} type="button" role="tab" aria-selected={mode === value} className={mode === value ? "is-on" : undefined} disabled={locked} onClick={() => setMode(value)}>
                    {value === "manual" ? t("Manual") : t("Auto")}
                  </button>
                ))}
              </div>

              <div className="dice-field">
                <small>{t("Card price")}</small>
                <div className="keno-bets dice-bets scratch-bets" role="radiogroup" aria-label={t("Card price")}>
                  {state.game.bets
                    .filter((value) => value <= state.tableMax)
                    .map((value) => (
                      <button
                        type="button"
                        key={value}
                        role="radio"
                        aria-checked={stake === value}
                        className={stake === value ? "is-on" : undefined}
                        disabled={locked}
                        onClick={() => {
                          setStake(value);
                          slotSound.click();
                        }}
                      >
                        {formatStake(value)}
                      </button>
                    ))}
                </div>
              </div>
              <div className="dice-profit">
                <small>{t("Top prize")}</small>
                <strong>{formatMoney(stake * state.game.maxMultiplier)}</strong>
              </div>

              {mode === "auto" ? (
                <div className="dice-auto">
                  <label className="dice-field">
                    <small>{t("Number of cards")}</small>
                    <span className="dice-input">
                      <input value={autoCount} inputMode="numeric" disabled={locked} onChange={(event) => setAutoCount(event.target.value)} aria-label={t("Number of cards")} />
                      <em aria-hidden="true">{autoCount.trim() === "" || Number(autoCount) === 0 ? "∞" : ""}</em>
                    </span>
                  </label>
                  <div className="dice-auto-limits">
                    <label className="dice-field">
                      <small>{t("Stop on profit")}</small>
                      <span className="dice-input">
                        <em aria-hidden="true">ALL</em>
                        <input value={stopProfit} placeholder="—" inputMode="decimal" disabled={locked} onChange={(event) => setStopProfit(event.target.value)} aria-label={t("Stop on profit")} />
                      </span>
                    </label>
                    <label className="dice-field">
                      <small>{t("Stop on loss")}</small>
                      <span className="dice-input">
                        <em aria-hidden="true">ALL</em>
                        <input value={stopLoss} placeholder="—" inputMode="decimal" disabled={locked} onChange={(event) => setStopLoss(event.target.value)} aria-label={t("Stop on loss")} />
                      </span>
                    </label>
                  </div>
                  {auto ? (
                    <p className="dice-auto-progress" aria-live="polite">
                      {auto.total === null ? t("Card {done}", { done: auto.done }) : t("Card {done} of {total}", { done: auto.done, total: auto.total })} ·{" "}
                      <span className={auto.profit < 0 ? "is-loss" : auto.profit > 0 ? "is-win" : undefined}>
                        {auto.profit > 0 ? "+" : ""}
                        {formatMoney(auto.profit)}
                      </span>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {mode === "manual" ? (
                scratchable ? (
                  <button type="button" className="dice-go scratch-go is-reveal" onClick={() => void revealAll(REVEAL_GAP_MS)}>
                    {t("Reveal all")}
                  </button>
                ) : (
                  <button type="button" className="dice-go scratch-go" disabled={busy || !!stakeProblem} onClick={() => void buyManual()}>
                    {busy ? t("Buying…") : t("Buy a card for {amount}", { amount: formatStake(stake) })}
                  </button>
                )
              ) : auto ? (
                <button type="button" className="dice-go is-stop" onClick={() => (autoStop.current = true)}>
                  {t("Stop autoplay")}
                </button>
              ) : (
                <button type="button" className="dice-go scratch-go" disabled={busy || !!stakeProblem} onClick={() => void startAuto()}>
                  {t("Start autoplay")}
                </button>
              )}
              {stakeProblem && !scratchable ? (
                <p className="dice-problem">{stakeProblem}</p>
              ) : (
                <p className="dice-hint">{mode === "auto" ? t("Press Space to start or stop.") : scratchable ? t("Press Space to reveal the card.") : t("Press Space to buy a card.")}</p>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last cards")}
          <HelpTip text="Your newest scratch cards. Tap one to see its seeds and check it. They're also in My money, as one Scratch Cards line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No cards yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <button type="button" className="report-list-row dice-row" key={row.id} onClick={() => setDetail(row)}>
                <div>
                  <strong className={row.multiplier > 0 ? "is-good" : "is-bad"}>{row.symbol ? `${t("3 × {symbol}", { symbol: symbolName(row.symbol) })} · ${row.multiplier}×` : t("No match")}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {t("{amount} card", { amount: formatMoney(row.bet) })}
                  </span>
                </div>
                <strong className={row.multiplier > 0 ? undefined : "is-bad"}>{formatMoney(row.win)}</strong>
              </button>
            ))}
          </div>
        )}
      </section>

      {sheet === "rules" ? (
        <Sheet title={t("Pays and rules")} onClose={() => setSheet(null)}>
          <p>{t("A card has 9 boxes. Scratch them, or reveal them all at once. Three of the same symbol win that symbol's prize, in times the card's price. A card never has two winning symbols.")}</p>
          <div className="scratch-pays">
            {prizes.map((prize) => (
              <div key={prize.symbol}>
                <span className="scratch-legend-symbols">
                  <SymbolArt symbol={prize.symbol} />
                  <SymbolArt symbol={prize.symbol} />
                  <SymbolArt symbol={prize.symbol} />
                </span>
                <span>{symbolName(prize.symbol)}</span>
                <strong>{prize.multiplier.toLocaleString("en-US")}×</strong>
                <small className="muted">{t("1 card in {count}", { count: Math.round(100 / prize.chance).toLocaleString("en-US") })}</small>
              </div>
            ))}
          </div>
          <p>
            {t("About {chance}% of cards win something; three cherries give the price back. On average a card pays back {rate}% of its price.", { chance: state.game.winChance, rate: state.game.payoutRate })}
          </p>
          <p>
            {t("A card costs {min} to {max}, never more than your max stake. The card is decided and paid when you buy it; scratching only shows it. Autoplay buys and reveals cards for you and stops after the number of cards you set, when it reaches your stop on profit or stop on loss, or when you stop it.", {
              min: formatStake(state.game.bets[0]),
              max: formatStake(state.tableMax),
            })}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {t("Every card is made on our server from seeds you can check: see Provably fair.")}
          </p>
        </Sheet>
      ) : null}

      {sheet === "fair" ? (
        <Sheet title={t("Provably fair")} onClose={() => setSheet(null)}>
          <p>
            {t("Each card comes from three things: our server seed, your client seed, and a nonce that counts your rounds. Before you buy, you see only a fingerprint (SHA-256 hash) of the server seed, so we can't change it without you noticing. When you change seeds, the old server seed is shown, and you can check every card it made. Dice, Keno, Coin Flip and Scratch Cards share the same seeds.")}
          </p>
          <h3 className="dice-sheet-heading">{t("Your seeds now")}</h3>
          <SeedLine label={t("Server seed (hashed)")} value={seed.serverSeedHash} onCopy={copy} />
          <SeedLine label={t("Client seed")} value={seed.clientSeed} onCopy={copy} />
          <SeedLine label={t("Rounds made with these seeds")} value={String(seed.nonce)} />
          <label className="dice-field dice-seed-edit">
            <small>{t("New client seed")}</small>
            <span className="dice-input">
              <input value={newClientSeed} maxLength={32} onChange={(event) => setNewClientSeed(event.target.value)} aria-label={t("New client seed")} />
            </span>
          </label>
          <button type="button" className="dice-go scratch-go" disabled={locked || changingSeed} onClick={() => void changeSeed()}>
            {changingSeed ? t("Changing…") : t("Change seeds")}
          </button>

          {previousSeed ? (
            <>
              <h3 className="dice-sheet-heading">{t("Your last seeds, now shown")}</h3>
              <SeedLine label={t("Server seed")} value={previousSeed.serverSeed ?? ""} onCopy={copy} />
              <SeedLine label={t("Server seed (hashed)")} value={previousSeed.serverSeedHash} onCopy={copy} />
              <SeedLine label={t("Client seed")} value={previousSeed.clientSeed} onCopy={copy} />
              <SeedLine label={t("Rounds made with these seeds")} value={String(previousSeed.nonce)} />
            </>
          ) : null}

          <h3 className="dice-sheet-heading">{t("Check a card")}</h3>
          <div className="dice-verify">
            <label className="dice-field">
              <small>{t("Server seed")}</small>
              <span className="dice-input">
                <input value={verify.serverSeed} onChange={(event) => setVerify({ ...verify, serverSeed: event.target.value.trim() })} aria-label={t("Server seed")} />
              </span>
            </label>
            <label className="dice-field">
              <small>{t("Client seed")}</small>
              <span className="dice-input">
                <input value={verify.clientSeed} onChange={(event) => setVerify({ ...verify, clientSeed: event.target.value.trim() })} aria-label={t("Client seed")} />
              </span>
            </label>
            <label className="dice-field">
              <small>{t("Nonce")}</small>
              <span className="dice-input">
                <input value={verify.nonce} inputMode="numeric" onChange={(event) => setVerify({ ...verify, nonce: event.target.value.trim() })} aria-label={t("Nonce")} />
              </span>
            </label>
          </div>
          {verified ? (
            <div className="dice-verify-out">
              <span>
                <small>{t("Result")}</small>
                {verified.cells ? <MiniCard cells={verified.cells} symbol={verified.symbol} /> : <strong>—</strong>}
              </span>
              <span>
                <small>{t("Its hash")}</small>
                <code>{verified.hash}</code>
              </span>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("Paste a server seed that has been shown, its client seed and a nonce.")}</p>
          )}
          <p className="muted dice-formula">{t("The i-th number is HMAC_SHA256(serverSeed, clientSeed:nonce:i)[0..3] ÷ 2³². The first picks the prize, the next fill the other boxes, the last shuffle them.")}</p>
        </Sheet>
      ) : null}

      {detail ? (
        <Sheet title={t("Card details")} onClose={() => setDetail(null)}>
          <div className={`dice-detail-head${detail.multiplier > 0 ? " is-win" : " is-loss"}`}>
            <MiniCard cells={detail.cells} symbol={detail.symbol} />
            <span>{detail.symbol ? t("3 × {symbol}: you won {amount}", { symbol: symbolName(detail.symbol), amount: formatMoney(detail.win) }) : t("No win this time")}</span>
          </div>
          <div className="dice-detail-grid">
            <SeedLine label={t("Multiplier")} value={`${detail.multiplier}×`} />
            <SeedLine label={t("Card price")} value={formatMoney(detail.bet)} />
            <SeedLine label={t("Paid")} value={formatMoney(detail.win)} />
            <SeedLine label={t("Time")} value={date(detail.createdAt, { ...TIME, day: "numeric", month: "short" })} />
          </div>
          <SeedLine label={t("Server seed (hashed)")} value={detail.serverSeedHash} onCopy={copy} />
          <SeedLine label={t("Client seed")} value={detail.clientSeed} onCopy={copy} />
          <SeedLine label={t("Nonce")} value={String(detail.nonce)} />
          {detail.serverSeed ? (
            <>
              <SeedLine label={t("Server seed")} value={detail.serverSeed} onCopy={copy} />
              <button
                type="button"
                className="dice-go scratch-go"
                onClick={() => {
                  setVerify({ serverSeed: detail.serverSeed ?? "", clientSeed: detail.clientSeed, nonce: String(detail.nonce) });
                  setDetail(null);
                  setSheet("fair");
                }}
              >
                {t("Check this card")}
              </button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("The server seed is shown once you change seeds. Then you can check this card.")}</p>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}
