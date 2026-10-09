"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { SeedLine, Sheet, ShieldIcon } from "./fair-play";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { apiFetch, newIdempotencyKey, type CoinFlipResult, type CoinFlipRound, type CoinFlipState, type CoinSide, type DiceSeed, type DiceSeedChange } from "../lib/api";
import { flipFromSeeds } from "../lib/coin-flip";
import { sha256Hex } from "../lib/dice";
import { formatMoney, formatStake } from "../lib/format";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

/** How long a toss takes, and how many times the coin turns over in it. Autoplay tosses faster. */
const TOSS = { duration: 1150, turns: 5 };
const AUTO_TOSS = { duration: 560, turns: 3 };
/** The pause between autoplay flips. */
const AUTO_GAP_MS = 200;

type Verify = { serverSeed: string; clientSeed: string; nonce: string };

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
/** ALL typed by the Player, or NaN. Whole cents only. */
function parseMoney(text: string): number {
  const value = Number(text.replace(",", ".").replace(/[$\s]/g, ""));
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? Math.round(value * 100) / 100 : Number.NaN;
}

/** Wins in a row at the start of these flips, newest first. */
const streakOf = (rows: CoinFlipRound[]) => {
  const first = rows.findIndex((row) => !row.won);
  return first === -1 ? rows.length : first;
};

/** A face's emblem: a crown for heads, a star for tails. */
function Emblem({ side }: { side: CoinSide }) {
  return side === "HEADS" ? (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="coin-emblem">
      <path d="M14 44 L10 20 L23 30 L32 14 L41 30 L54 20 L50 44 Z" />
      <rect x="14" y="47" width="36" height="5" rx="2" />
      <circle cx="10" cy="19" r="3" />
      <circle cx="32" cy="12" r="3" />
      <circle cx="54" cy="19" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 64 64" aria-hidden="true" className="coin-emblem">
      <path d="M32 9 L38.6 24.6 L55.5 26.1 L42.7 37.2 L46.5 53.7 L32 45 L17.5 53.7 L21.3 37.2 L8.5 26.1 L25.4 24.6 Z" />
    </svg>
  );
}

/** A small coin showing one side, for the call buttons and the history. */
function MiniCoin({ side }: { side: CoinSide }) {
  return (
    <span className={`coin-mini is-${side.toLowerCase()}`} aria-hidden="true">
      <Emblem side={side} />
    </span>
  );
}

/** Coin Flip for a Player: call heads or tails, flip, and check every flip from its seeds. */
export function CoinFlipGame() {
  const { getToken } = useAuth();
  const { t, ts, date } = useI18n();
  const toast = useToast();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<CoinFlipState | null>(null);
  const [balance, setBalance] = useState(0);
  const [stake, setStake] = useState(100);
  const [call, setCall] = useState<CoinSide>("HEADS");
  const [recent, setRecent] = useState<CoinFlipRound[]>([]);
  const [seed, setSeed] = useState<DiceSeed | null>(null);
  const [previousSeed, setPreviousSeed] = useState<DiceSeed | null>(null);
  /** The last flip, shown once the coin has landed. */
  const [result, setResult] = useState<CoinFlipRound | null>(null);
  /** The coin's turn, in degrees: a whole number of turns is heads up, half a turn more is tails. */
  const [angle, setAngle] = useState(0);
  const [toss, setToss] = useState<{ key: number; duration: number } | null>(null);
  const [flipping, setFlipping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [autoCount, setAutoCount] = useState("10");
  const [stopProfit, setStopProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [auto, setAuto] = useState<{ done: number; total: number | null; profit: number } | null>(null);
  /** This visit's flips and profit. */
  const [visit, setVisit] = useState({ flips: 0, profit: 0, wins: 0 });
  const [sheet, setSheet] = useState<"rules" | "fair" | null>(null);
  const [detail, setDetail] = useState<CoinFlipRound | null>(null);
  const [newClientSeed, setNewClientSeed] = useState("");
  const [changingSeed, setChangingSeed] = useState(false);
  const [verify, setVerify] = useState<Verify>({ serverSeed: "", clientSeed: "", nonce: "0" });
  const [verified, setVerified] = useState<{ side: CoinSide | null; hash: string } | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const balanceRef = useRef(0);
  balanceRef.current = balance;
  const angleRef = useRef(0);
  const tossKey = useRef(0);
  const landTimer = useRef<number | null>(null);
  const autoStop = useRef(false);
  const reducedMotion = useRef(false);

  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => {
    reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return () => {
      autoStop.current = true;
      if (landTimer.current) window.clearTimeout(landTimer.current);
    };
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<CoinFlipState>("/casino/coin-flip", token);
    setState(next);
    setBalance(next.balance);
    setRecent(next.recent);
    setSeed(next.seed);
    setPreviousSeed(next.previousSeed);
    setNewClientSeed(next.seed.clientSeed);
    // Keep the stake if it's still one of the bets within the Player's max stake; otherwise the biggest that is.
    const allowed = next.game.bets.filter((value) => value <= next.tableMax);
    setStake((current) => (allowed.includes(current) ? current : (allowed.filter((value) => value <= current).pop() ?? allowed[0] ?? next.game.bets[0])));
    if (next.recent[0]) {
      const last = next.recent[0];
      setResult(last);
      setCall(last.call);
      const resting = last.side === "TAILS" ? 180 : 0;
      angleRef.current = resting;
      setAngle(resting);
    }
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy && !auto) setBalance(event.balance);
  });

  const multiplier = state?.game.multiplier ?? 1.8;
  const profitOnWin = Math.round((Math.floor(stake * multiplier * 100) / 100 - stake) * 100) / 100;
  const stakeProblem = (() => {
    if (!state) return null;
    if (stake > state.tableMax) return t("The most a flip can cost you is {amount}.", { amount: formatMoney(state.tableMax) });
    if (stake > balance) return t("Your balance is too low for this stake.");
    return null;
  })();
  const locked = busy || auto !== null;
  const streak = streakOf(recent);

  /** Tosses the coin: it rises, turns over and lands on `side`. Resolves when it's down. */
  const landOn = useCallback((side: CoinSide, timing: { duration: number; turns: number } | null) => {
    if (landTimer.current) window.clearTimeout(landTimer.current);
    // Always forward: the next whole turn, the toss's turns, and half a turn more for tails.
    const next = Math.ceil(angleRef.current / 360) * 360 + (timing && !document.hidden ? timing.turns * 360 : 0) + (side === "TAILS" ? 180 : 0);
    angleRef.current = next;
    if (!timing || document.hidden) {
      setToss(null);
      setAngle(next);
      setFlipping(false);
      return Promise.resolve();
    }
    tossKey.current += 1;
    setToss({ key: tossKey.current, duration: timing.duration });
    setAngle(next);
    setFlipping(true);
    return new Promise<void>((resolve) => {
      landTimer.current = window.setTimeout(() => {
        setFlipping(false);
        resolve();
      }, timing.duration);
    });
  }, []);

  /** One flip at the stake and call on the table. Returns the result, or null if it didn't go through. */
  const flipOnce = useCallback(
    async (fast: boolean): Promise<CoinFlipResult | null> => {
      if (!state || state.closed) return null;
      if (stake > state.tableMax || stake > balanceRef.current + 1e-9) {
        if (stakeProblem) toast.error(stakeProblem);
        return null;
      }
      slotSound.unlock();
      slotSound.coinToss();
      let response: CoinFlipResult;
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        response = await apiFetch<CoinFlipResult>("/casino/coin-flip/flip", token, { method: "POST", body: JSON.stringify({ bet: stake, call }), idempotencyKey: newIdempotencyKey() });
      } catch (err) {
        toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
        return null;
      }
      const { round } = response;
      // The stake leaves straight away; the win arrives as the coin lands.
      setBalance(Math.round((balanceRef.current - round.bet) * 100) / 100);
      setResult(null);
      await landOn(round.side, reducedMotion.current ? null : fast ? AUTO_TOSS : TOSS);
      slotSound.coinLand(round.won);
      setResult(round);
      setBalance(response.balance);
      setSeed(response.seed);
      setRecent((rows) => [round, ...rows].slice(0, 20));
      setVisit((current) => ({ flips: current.flips + 1, wins: current.wins + (round.won ? 1 : 0), profit: Math.round((current.profit + round.win - round.bet) * 100) / 100 }));
      return response;
    },
    [state, stake, stakeProblem, call, getToken, t, ts, toast, landOn],
  );

  async function flipManual() {
    if (locked) return;
    setBusy(true);
    try {
      await flipOnce(false);
    } finally {
      setBusy(false);
    }
  }

  async function startAuto() {
    if (locked || !state) return;
    const count = autoCount.trim() === "" || Number(autoCount) === 0 ? null : Math.floor(Number(autoCount));
    if (count !== null && (!Number.isFinite(count) || count < 1 || count > 1000)) {
      toast.error(t("Set from 1 to 1,000 flips, or 0 to keep going until you stop."));
      return;
    }
    const profitLimit = stopProfit.trim() ? parseMoney(stopProfit) : null;
    const lossLimit = stopLoss.trim() ? parseMoney(stopLoss) : null;
    if ((profitLimit !== null && !(profitLimit > 0)) || (lossLimit !== null && !(lossLimit > 0))) {
      toast.error(t("Stop on profit and stop on loss are amounts above 0 ALL, or empty."));
      return;
    }
    autoStop.current = false;
    let done = 0;
    let profit = 0;
    setAuto({ done, total: count, profit });
    while (!autoStop.current && (count === null || done < count)) {
      const response = await flipOnce(true);
      if (!response) break;
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
      await sleep(reducedMotion.current ? 60 : AUTO_GAP_MS);
    }
    setAuto(null);
  }

  // Space presses the main button on a computer: a flip, or autoplay's start and stop. Not while typing or with a sheet open.
  const mainAction = useRef<() => void>(() => undefined);
  mainAction.current = () => {
    if (mode === "manual") void flipManual();
    else if (auto) autoStop.current = true;
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
      const side = verify.clientSeed && Number.isInteger(nonce) && nonce >= 0 ? await flipFromSeeds(verify.serverSeed, verify.clientSeed, nonce) : null;
      if (current) setVerified({ side, hash });
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
      const change = await apiFetch<DiceSeedChange>("/casino/coin-flip/seed", token, { method: "POST", body: JSON.stringify(clientSeed ? { clientSeed } : {}) });
      setSeed(change.seed);
      setPreviousSeed(change.previousSeed);
      setNewClientSeed(change.seed.clientSeed);
      // Flips made with the old pair can be checked now.
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

  const sideName = (side: CoinSide) => (side === "HEADS" ? t("Heads") : t("Tails"));
  const outcome = result && !flipping ? (result.won ? " is-win" : " is-loss") : "";

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Coin Flip")}</h1>
          <p className="muted report-subtitle">{t("Call heads or tails and flip. Every flip can be checked. Played with your balance.")}</p>
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
        <section ref={cabinet} className={`dice-cabinet coin-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={t("Coin Flip")}>
          <header className="slot-marquee dice-marquee coin-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">{t("Coin Flip")}</span>
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
            <div className="dice-stage coin-stage">
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
                  <small>{t("Flips won")}</small>
                  <strong>
                    {visit.wins} / {visit.flips}
                  </strong>
                </span>
              </div>

              <div className="dice-history coin-history" aria-label={t("Your last flips")}>
                {recent.slice(0, 16).map((row) => (
                  <button type="button" key={row.id} className={`coin-chip${row.won ? " is-win" : " is-loss"}`} onClick={() => setDetail(row)} title={`${sideName(row.side)} · ${t("Flip details")}`}>
                    <MiniCoin side={row.side} />
                  </button>
                ))}
              </div>

              <div className={`coin-arena${outcome}${flipping ? " is-flipping" : ""}`} aria-live="polite">
                <div className="coin-scene" role="img" aria-label={flipping || !result ? t("The coin is in the air") : t("The coin shows {side}", { side: sideName(result.side) })}>
                  <div className={`coin-toss${toss ? ` is-tossed-${toss.key % 2}` : ""}`} style={{ "--toss-ms": `${toss?.duration ?? 0}ms` } as CSSProperties}>
                    <div className="coin" style={{ transform: `rotateX(${angle}deg)`, transitionDuration: `${toss?.duration ?? 0}ms` }}>
                      {Array.from({ length: 7 }, (_, index) => (
                        <span key={index} className="coin-edge" style={{ transform: `translateZ(${index - 3}px)` }} />
                      ))}
                      <span className="coin-face is-heads">
                        <Emblem side="HEADS" />
                      </span>
                      <span className="coin-face is-tails">
                        <Emblem side="TAILS" />
                      </span>
                    </div>
                  </div>
                  <span className={`coin-shadow${toss ? ` is-tossed-${toss.key % 2}` : ""}`} style={{ "--toss-ms": `${toss?.duration ?? 0}ms` } as CSSProperties} />
                </div>
                <span className="coin-result">{flipping ? "…" : result ? sideName(result.side) : "—"}</span>
                <span className="dice-result-note coin-note">
                  {flipping
                    ? t("The coin is in the air")
                    : !result
                      ? t("Call heads or tails, then flip.")
                      : result.won
                        ? streak >= 2
                          ? t("Won {amount} · {count} in a row", { amount: formatMoney(result.win), count: streak })
                          : t("You won {amount}", { amount: formatMoney(result.win) })
                        : t("No win this time")}
                </span>
              </div>

              <div className="coin-calls" role="radiogroup" aria-label={t("Your call")}>
                {state.game.sides.map((side) => (
                  <button
                    type="button"
                    key={side}
                    role="radio"
                    aria-checked={call === side}
                    className={`coin-call is-${side.toLowerCase()}${call === side ? " is-on" : ""}`}
                    disabled={locked}
                    onClick={() => {
                      setCall(side);
                      slotSound.click();
                    }}
                  >
                    <MiniCoin side={side} />
                    <span>
                      <strong>{sideName(side)}</strong>
                      <small>{multiplier.toFixed(2)}×</small>
                    </span>
                  </button>
                ))}
              </div>
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
                <small>{t("Stake")}</small>
                <div className="keno-bets dice-bets coin-bets" role="radiogroup" aria-label={t("Stake")}>
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
                <small>{t("Profit on win")}</small>
                <strong>+{formatMoney(profitOnWin)}</strong>
              </div>

              {mode === "auto" ? (
                <div className="dice-auto">
                  <label className="dice-field">
                    <small>{t("Number of flips")}</small>
                    <span className="dice-input">
                      <input value={autoCount} inputMode="numeric" disabled={locked} onChange={(event) => setAutoCount(event.target.value)} aria-label={t("Number of flips")} />
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
                      {auto.total === null ? t("Flip {done}", { done: auto.done }) : t("Flip {done} of {total}", { done: auto.done, total: auto.total })} ·{" "}
                      <span className={auto.profit < 0 ? "is-loss" : auto.profit > 0 ? "is-win" : undefined}>
                        {auto.profit > 0 ? "+" : ""}
                        {formatMoney(auto.profit)}
                      </span>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {mode === "manual" ? (
                <button type="button" className="dice-go coin-go" disabled={busy || !!stakeProblem} onClick={() => void flipManual()}>
                  {busy ? t("Flipping…") : t("Flip the coin")}
                </button>
              ) : auto ? (
                <button type="button" className="dice-go is-stop" onClick={() => (autoStop.current = true)}>
                  {t("Stop autoplay")}
                </button>
              ) : (
                <button type="button" className="dice-go coin-go" disabled={busy || !!stakeProblem} onClick={() => void startAuto()}>
                  {t("Start autoplay")}
                </button>
              )}
              {stakeProblem ? <p className="dice-problem">{stakeProblem}</p> : <p className="dice-hint">{mode === "manual" ? t("Press Space to flip.") : t("Press Space to start or stop.")}</p>}
            </div>
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last flips")}
          <HelpTip text="Your newest coin flips. Tap one to see its seeds and check it. They're also in My money, as one Coin Flip line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No flips yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <button type="button" className="report-list-row dice-row" key={row.id} onClick={() => setDetail(row)}>
                <div>
                  <strong className={row.won ? "is-good" : "is-bad"}>{sideName(row.side)}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {t("called {side}", { side: sideName(row.call) })} · {t("{amount} stake", { amount: formatMoney(row.bet) })}
                  </span>
                </div>
                <strong className={row.won ? undefined : "is-bad"}>{formatMoney(row.win)}</strong>
              </button>
            ))}
          </div>
        )}
      </section>

      {sheet === "rules" ? (
        <Sheet title={t("Pays and rules")} onClose={() => setSheet(null)}>
          <p>{t("Call heads or tails, then flip the coin. Each side comes up half the time.")}</p>
          <p>{t("A right call pays {multiplier}× the stake: 100 ALL pays 180 ALL. On average a flip pays back {rate}% of the stake.", { multiplier: state.game.multiplier, rate: state.game.payoutRate })}</p>
          <p>
            {t("A flip costs {min} to {max}, never more than your max stake. Autoplay flips for you with the same call and stops after the number of flips you set, when it reaches your stop on profit or stop on loss, or when you stop it.", {
              min: formatStake(state.game.bets[0]),
              max: formatStake(state.tableMax),
            })}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {t("Every flip is made on our server from seeds you can check: see Provably fair.")}
          </p>
        </Sheet>
      ) : null}

      {sheet === "fair" ? (
        <Sheet title={t("Provably fair")} onClose={() => setSheet(null)}>
          <p>
            {t("Each flip comes from three things: our server seed, your client seed, and a nonce that counts your rounds. Before you flip, you see only a fingerprint (SHA-256 hash) of the server seed, so we can't change it without you noticing. When you change seeds, the old server seed is shown, and you can check every flip it made. Dice, Keno and Coin Flip share the same seeds.")}
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
          <button type="button" className="dice-go coin-go" disabled={locked || changingSeed} onClick={() => void changeSeed()}>
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

          <h3 className="dice-sheet-heading">{t("Check a flip")}</h3>
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
                <strong>{verified.side === null ? "—" : sideName(verified.side)}</strong>
              </span>
              <span>
                <small>{t("Its hash")}</small>
                <code>{verified.hash}</code>
              </span>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("Paste a server seed that has been shown, its client seed and a nonce.")}</p>
          )}
          <p className="muted dice-formula">HMAC_SHA256(serverSeed, clientSeed + &quot;:&quot; + nonce)[0..3] ÷ 2³²: {t("below 0.5 is heads, otherwise tails")}</p>
        </Sheet>
      ) : null}

      {detail ? (
        <Sheet title={t("Flip details")} onClose={() => setDetail(null)}>
          <div className={`dice-detail-head${detail.won ? " is-win" : " is-loss"}`}>
            <strong>{sideName(detail.side)}</strong>
            <span>{detail.won ? t("You won {amount}", { amount: formatMoney(detail.win) }) : t("No win this time")}</span>
          </div>
          <div className="dice-detail-grid">
            <SeedLine label={t("Your call")} value={sideName(detail.call)} />
            <SeedLine label={t("Multiplier")} value={`${detail.multiplier.toFixed(2)}×`} />
            <SeedLine label={t("Stake")} value={formatMoney(detail.bet)} />
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
                className="dice-go coin-go"
                onClick={() => {
                  setVerify({ serverSeed: detail.serverSeed ?? "", clientSeed: detail.clientSeed, nonce: String(detail.nonce) });
                  setDetail(null);
                  setSheet("fair");
                }}
              >
                {t("Check this flip")}
              </button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("The server seed is shown once you change seeds. Then you can check this flip.")}</p>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}
