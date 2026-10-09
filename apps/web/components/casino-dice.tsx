"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Dice3D, FIRST_IMPACT } from "./dice-3d";
import { newThrow, throwLength, type DiceThrow } from "./dice-tray";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { apiFetch, newIdempotencyKey, type DiceRoll, type DiceRollResult, type DiceSeed, type DiceSeedChange, type DiceState } from "../lib/api";
import { clampWinning, flip, multiplierOf, payoutOf, points, rollFromSeeds, sha256Hex, targetFor, targetRange, winningForMultiplier, winningNumbers, type DiceDirection } from "../lib/dice";
import { formatMoney } from "../lib/format";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

/** How the dice tumble: how long the first one takes, and how much later each next one lands. Autoplay throws faster. */
const THROW = { duration: 760, stagger: 150 };
const AUTO_THROW = { duration: 380, stagger: 60 };
/** The pause between autoplay rolls. */
const AUTO_GAP_MS = 180;

type Field = "multiplier" | "target" | "chance";
type Verify = { serverSeed: string; clientSeed: string; nonce: string };

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
/** Dollars typed by the Player, or NaN. Whole cents only. */
function parseMoney(text: string): number {
  const value = Number(text.replace(",", ".").replace(/[$\s]/g, ""));
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? Math.round(value * 100) / 100 : Number.NaN;
}

/** Dice for a Player: set a target, roll over or under it, and check every roll from its seeds. */
export function DiceGame() {
  const { getToken } = useAuth();
  const { t, ts, date } = useI18n();
  const toast = useToast();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<DiceState | null>(null);
  const [balance, setBalance] = useState(0);
  const [stakeText, setStakeText] = useState("1.00");
  const [direction, setDirection] = useState<DiceDirection>("UNDER");
  const [target, setTarget] = useState(5000);
  /** A field the Player is typing in, kept as text until they leave it. */
  const [editing, setEditing] = useState<{ field: Field; text: string } | null>(null);
  const [recent, setRecent] = useState<DiceRoll[]>([]);
  const [seed, setSeed] = useState<DiceSeed | null>(null);
  const [previousSeed, setPreviousSeed] = useState<DiceSeed | null>(null);
  /** The last roll on the track (in hundredths), and the number shown while it counts up to it. */
  const [result, setResult] = useState<{ roll: number; won: boolean; win: number; multiplier: number } | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [dice, setDice] = useState<DiceThrow | null>(null);
  const [rolling, setRolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [autoCount, setAutoCount] = useState("10");
  const [stopProfit, setStopProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [auto, setAuto] = useState<{ done: number; total: number | null; profit: number } | null>(null);
  /** This visit's rolls and profit. */
  const [visit, setVisit] = useState({ rolls: 0, profit: 0, wins: 0 });
  const [sheet, setSheet] = useState<"rules" | "fair" | null>(null);
  const [detail, setDetail] = useState<DiceRoll | null>(null);
  const [newClientSeed, setNewClientSeed] = useState("");
  const [changingSeed, setChangingSeed] = useState(false);
  const [verify, setVerify] = useState<Verify>({ serverSeed: "", clientSeed: "", nonce: "0" });
  const [verified, setVerified] = useState<{ roll: number | null; hash: string } | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const balanceRef = useRef(0);
  balanceRef.current = balance;
  const throwKey = useRef(0);
  const landTimers = useRef<number[]>([]);
  const autoStop = useRef(false);
  const reducedMotion = useRef(false);

  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => {
    reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return () => {
      autoStop.current = true;
      landTimers.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<DiceState>("/casino/dice", token);
    setState(next);
    setBalance(next.balance);
    setRecent(next.recent);
    setSeed(next.seed);
    setPreviousSeed(next.previousSeed);
    setNewClientSeed(next.seed.clientSeed);
    setStakeText((current) => (parseMoney(current) > next.tableMax ? next.tableMax.toFixed(2) : current));
    if (next.recent[0]) {
      const last = next.recent[0];
      const roll = Math.round(last.roll * 100);
      setResult({ roll, won: last.won, win: last.win, multiplier: last.multiplier });
      setShown(roll);
      throwKey.current += 1;
      setDice(newThrow(roll, throwKey.current, 0, 0));
    }
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy && !auto) setBalance(event.balance);
  });

  const stake = parseMoney(stakeText);
  const winning = winningNumbers(target, direction);
  const multiplier = multiplierOf(winning);
  const chance = winning / 100;
  const profitOnWin = Number.isFinite(stake) ? Math.round((payoutOf(stake, winning) - stake) * 100) / 100 : 0;
  const stakeProblem = (() => {
    if (!state) return null;
    if (!Number.isFinite(stake)) return t("Type a stake in dollars and cents.");
    if (stake < state.game.minBet) return t("The smallest roll is {amount}.", { amount: formatMoney(state.game.minBet) });
    if (stake > state.tableMax) return t("The most a roll can cost you is {amount}.", { amount: formatMoney(state.tableMax) });
    if (stake > balance) return t("Your balance is too low for this stake.");
    return null;
  })();
  const locked = busy || auto !== null;

  /**
   * Throws the dice onto the tray: they tumble and land one after another on the roll's digits, each
   * with a knock, and once the last is down the marker moves to the roll. Resolves when they've landed.
   */
  const landOn = useCallback((roll: number, timing: { duration: number; stagger: number } | null) => {
    landTimers.current.forEach((timer) => window.clearTimeout(timer));
    landTimers.current = [];
    throwKey.current += 1;
    // A hidden tab, or a Player who asks for less motion: the dice are simply there.
    const next = newThrow(roll, throwKey.current, timing && !document.hidden ? timing.duration : 0, timing && !document.hidden ? timing.stagger : 0);
    setDice(next);
    const total = throwLength(next);
    if (total === 0) {
      setShown(roll);
      setRolling(false);
      return Promise.resolve();
    }
    setRolling(true);
    next.digits.forEach((_, index) => {
      // Each die knocks as it first hits the felt.
      landTimers.current.push(window.setTimeout(() => slotSound.dieLand(index), (next.duration + next.stagger * index) * FIRST_IMPACT));
    });
    return new Promise<void>((resolve) => {
      landTimers.current.push(
        window.setTimeout(() => {
          setShown(roll);
          setRolling(false);
          resolve();
        }, total),
      );
    });
  }, []);

  /** One roll at the stake and target on the table. Returns the result, or null if it didn't go through. */
  const rollOnce = useCallback(
    async (fast: boolean): Promise<DiceRollResult | null> => {
      if (!state || state.closed) return null;
      if (!Number.isFinite(stake) || stake < state.game.minBet || stake > state.tableMax || stake > balanceRef.current + 1e-9) {
        if (stakeProblem) toast.error(stakeProblem);
        return null;
      }
      slotSound.unlock();
      slotSound.diceRoll();
      let response: DiceRollResult;
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        const body = JSON.stringify({ bet: stake, target: target / 100, direction });
        response = await apiFetch<DiceRollResult>("/casino/dice/roll", token, { method: "POST", body, idempotencyKey: newIdempotencyKey() });
      } catch (err) {
        toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
        return null;
      }
      const { round } = response;
      const roll = Math.round(round.roll * 100);
      // The stake leaves straight away; the win arrives as the roll lands.
      setBalance(Math.round((balanceRef.current - round.bet) * 100) / 100);
      setResult({ roll, won: round.won, win: round.win, multiplier: round.multiplier });
      await landOn(roll, reducedMotion.current ? null : fast ? AUTO_THROW : THROW);
      slotSound.diceResult(round.won, round.multiplier);
      setBalance(response.balance);
      setSeed(response.seed);
      setRecent((rows) => [round, ...rows].slice(0, 20));
      setVisit((current) => ({ rolls: current.rolls + 1, wins: current.wins + (round.won ? 1 : 0), profit: Math.round((current.profit + round.win - round.bet) * 100) / 100 }));
      return response;
    },
    [state, stake, stakeProblem, target, direction, getToken, t, ts, toast, landOn],
  );

  async function rollManual() {
    if (locked) return;
    setBusy(true);
    try {
      await rollOnce(false);
    } finally {
      setBusy(false);
    }
  }

  async function startAuto() {
    if (locked || !state) return;
    const count = autoCount.trim() === "" || Number(autoCount) === 0 ? null : Math.floor(Number(autoCount));
    if (count !== null && (!Number.isFinite(count) || count < 1 || count > 1000)) {
      toast.error(t("Set from 1 to 1,000 rolls, or 0 to keep going until you stop."));
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
      const response = await rollOnce(true);
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

  // Space presses the main button on a computer: a roll, or autoplay's start and stop. Not while typing or with a sheet open.
  const mainAction = useRef<() => void>(() => undefined);
  mainAction.current = () => {
    if (mode === "manual") void rollManual();
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
      const roll = verify.clientSeed && Number.isInteger(nonce) && nonce >= 0 ? await rollFromSeeds(verify.serverSeed, verify.clientSeed, nonce) : null;
      if (current) setVerified({ roll, hash });
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
      const change = await apiFetch<DiceSeedChange>("/casino/dice/seed", token, { method: "POST", body: JSON.stringify(clientSeed ? { clientSeed } : {}) });
      setSeed(change.seed);
      setPreviousSeed(change.previousSeed);
      setNewClientSeed(change.seed.clientSeed);
      // Rolls made with the old pair can be checked now.
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

  function commit(field: Field, text: string) {
    const value = Number(text.replace(",", "."));
    setEditing(null);
    if (!Number.isFinite(value) || value <= 0) return;
    if (field === "multiplier") setTarget(targetFor(winningForMultiplier(value), direction));
    else if (field === "chance") setTarget(targetFor(clampWinning(value * 100), direction));
    else {
      const [low, high] = targetRange(direction);
      setTarget(Math.min(high, Math.max(low, Math.round(value * 100))));
    }
  }

  function setStake(value: number) {
    if (!state) return;
    const capped = Math.min(state.tableMax, Math.max(state.game.minBet, Math.floor(value * 100) / 100));
    setStakeText(capped.toFixed(2));
  }

  if (!state || !seed) return <PageLoading label="Loading the Casino" />;

  const [low, high] = targetRange(direction);
  const fieldText = (field: Field, value: string) => (editing?.field === field ? editing.text : value);
  const fieldProps = (field: Field, value: string) => ({
    value: fieldText(field, value),
    inputMode: "decimal" as const,
    disabled: locked,
    onFocus: () => setEditing({ field, text: value }),
    onChange: (event: ChangeEvent<HTMLInputElement>) => setEditing({ field, text: event.target.value }),
    onBlur: (event: FocusEvent<HTMLInputElement>) => commit(field, event.target.value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") event.currentTarget.blur();
    },
  });
  const sideName = direction === "UNDER" ? t("Roll under") : t("Roll over");
  const shownLabel = shown === null ? "--.--" : points(shown);
  const settled = result && !rolling ? (result.won ? "win" : "loss") : null;

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Dice")}</h1>
          <p className="muted report-subtitle">{t("Pick a target, roll over or under it. Every roll can be checked. Played with your balance.")}</p>
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
        <section ref={cabinet} className={`dice-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={t("Dice")}>
          <header className="slot-marquee dice-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">{t("Dice")}</span>
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
            <div className="dice-stage">
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
                  <small>{t("Rolls won")}</small>
                  <strong>
                    {visit.wins} / {visit.rolls}
                  </strong>
                </span>
              </div>

              <div className="dice-history" aria-label={t("Your last rolls")}>
                {recent.slice(0, 12).map((row) => (
                  <button type="button" key={row.id} className={`dice-chip${row.won ? " is-win" : " is-loss"}`} onClick={() => setDetail(row)} title={t("Roll details")}>
                    {row.roll.toFixed(2)}
                  </button>
                ))}
              </div>

              <div className={`dice-result${result ? (result.won ? " is-win" : " is-loss") : ""}${rolling ? " is-rolling" : ""}`} aria-live="polite">
                <Dice3D dice={dice} rolling={rolling} outcome={settled} label={rolling || shown === null ? t("The dice are rolling") : t("The dice show {roll}", { roll: shownLabel })} />
                <span className="dice-result-number" aria-hidden="true">
                  {shownLabel}
                </span>
                <span className="dice-result-note">
                  {!result
                    ? t("Set your target and roll.")
                    : result.won
                      ? t("Won {amount} at {multiplier}×", { amount: formatMoney(result.win), multiplier: result.multiplier.toFixed(4) })
                      : t("No win this time")}
                </span>
              </div>

              <div className="dice-track-wrap">
                <div className="dice-track" style={{ "--split": `${target / 100}%` } as CSSProperties}>
                  <div className={`dice-bar is-${direction.toLowerCase()}`} />
                  <input
                    type="range"
                    className="dice-range"
                    min={0}
                    max={9999}
                    step={1}
                    value={target}
                    disabled={locked}
                    aria-label={`${sideName} ${points(target)}`}
                    aria-valuetext={`${sideName} ${points(target)}, ${t("{chance}% chance", { chance: chance.toFixed(2) })}`}
                    onChange={(event) => setTarget(Math.min(high, Math.max(low, Number(event.target.value))))}
                  />
                  {result ? (
                    <span className={`dice-marker${result.won ? " is-win" : " is-loss"}`} style={{ left: `${(shown ?? result.roll) / 100}%` }} aria-hidden="true">
                      <span>{shownLabel}</span>
                    </span>
                  ) : null}
                </div>
                <div className="dice-scale" aria-hidden="true">
                  {[0, 25, 50, 75, 100].map((mark) => (
                    <span key={mark} style={{ left: `${mark}%` }}>
                      {mark}
                    </span>
                  ))}
                </div>
              </div>

              <div className="dice-stats">
                <label className="dice-field">
                  <small>{t("Multiplier")}</small>
                  <span className="dice-input">
                    <input {...fieldProps("multiplier", multiplier.toFixed(4))} aria-label={t("Multiplier")} />
                    <em aria-hidden="true">×</em>
                  </span>
                </label>
                <label className="dice-field">
                  <small>{sideName}</small>
                  <span className="dice-input">
                    <input {...fieldProps("target", points(target))} aria-label={sideName} />
                    <button
                      type="button"
                      className="dice-swap"
                      disabled={locked}
                      onClick={() => {
                        const next = flip(target, direction);
                        setDirection(next.direction);
                        setTarget(next.target);
                        slotSound.click();
                      }}
                      aria-label={direction === "UNDER" ? t("Switch to roll over") : t("Switch to roll under")}
                      title={direction === "UNDER" ? t("Switch to roll over") : t("Switch to roll under")}
                    >
                      ⇄
                    </button>
                  </span>
                </label>
                <label className="dice-field">
                  <small>{t("Win chance")}</small>
                  <span className="dice-input">
                    <input {...fieldProps("chance", chance.toFixed(2))} aria-label={t("Win chance")} />
                    <em aria-hidden="true">%</em>
                  </span>
                </label>
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

              <label className="dice-field">
                <small>{t("Stake")}</small>
                <span className={`dice-input is-stake${stakeProblem ? " is-bad" : ""}`}>
                  <em aria-hidden="true">ALL</em>
                  <input value={stakeText} inputMode="decimal" disabled={locked} aria-label={t("Stake")} onChange={(event) => setStakeText(event.target.value)} onBlur={() => Number.isFinite(stake) && setStake(stake)} />
                  <button type="button" disabled={locked} onClick={() => setStake((Number.isFinite(stake) ? stake : 1) / 2)}>
                    ½
                  </button>
                  <button type="button" disabled={locked} onClick={() => setStake((Number.isFinite(stake) ? stake : 1) * 2)}>
                    2×
                  </button>
                  <button type="button" disabled={locked} onClick={() => setStake(Math.min(state.tableMax, Math.floor(balance * 100) / 100))}>
                    {t("Max")}
                  </button>
                </span>
              </label>
              <div className="dice-profit">
                <small>{t("Profit on win")}</small>
                <strong>+{formatMoney(profitOnWin)}</strong>
              </div>

              {mode === "auto" ? (
                <div className="dice-auto">
                  <label className="dice-field">
                    <small>{t("Number of rolls")}</small>
                    <span className="dice-input">
                      <input value={autoCount} inputMode="numeric" disabled={locked} onChange={(event) => setAutoCount(event.target.value)} aria-label={t("Number of rolls")} />
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
                      {auto.total === null ? t("Roll {done}", { done: auto.done }) : t("Roll {done} of {total}", { done: auto.done, total: auto.total })} ·{" "}
                      <span className={auto.profit < 0 ? "is-loss" : auto.profit > 0 ? "is-win" : undefined}>
                        {auto.profit > 0 ? "+" : ""}
                        {formatMoney(auto.profit)}
                      </span>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {mode === "manual" ? (
                <button type="button" className="dice-go" disabled={busy || !!stakeProblem} onClick={() => void rollManual()}>
                  {busy ? t("Rolling…") : t("Roll")}
                </button>
              ) : auto ? (
                <button type="button" className="dice-go is-stop" onClick={() => (autoStop.current = true)}>
                  {t("Stop autoplay")}
                </button>
              ) : (
                <button type="button" className="dice-go" disabled={busy || !!stakeProblem} onClick={() => void startAuto()}>
                  {t("Start autoplay")}
                </button>
              )}
              {stakeProblem ? <p className="dice-problem">{stakeProblem}</p> : <p className="dice-hint">{mode === "manual" ? t("Press Space to roll.") : t("Press Space to start or stop.")}</p>}
            </div>
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last rolls")}
          <HelpTip text="Your newest dice rolls. Tap one to see its seeds and check it. They're also in My money, as one Dice line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No rolls yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <button type="button" className="report-list-row dice-row" key={row.id} onClick={() => setDetail(row)}>
                <div>
                  <strong className={row.won ? "is-good" : "is-bad"}>{row.roll.toFixed(2)}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {row.direction === "UNDER" ? t("under {target}", { target: row.target.toFixed(2) }) : t("over {target}", { target: row.target.toFixed(2) })} · {row.multiplier.toFixed(4)}× ·{" "}
                    {t("{amount} stake", { amount: formatMoney(row.bet) })}
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
          <p>{t("A roll is a number from 0.00 to 99.99, each as likely as any other. Pick a target and a side: under wins when the roll is below the target, over when it's above it. Drag the slider, or type the target, the multiplier or the win chance; the other two follow.")}</p>
          <p>
            {t("The win chance can be {min}% to {max}%. A win pays the stake times the multiplier, rounded down to 4 decimals: 50% pays 1.9400×, 1% pays {top}×. Cents are rounded down.", {
              min: state.game.minChance,
              max: state.game.maxChance,
              top: state.game.maxMultiplier,
            })}
          </p>
          <p>
            {t("A roll costs {min} to {max}, never more than your max stake. Autoplay rolls for you and stops after the number of rolls you set, when it reaches your stop on profit or stop on loss, or when you stop it.", {
              min: formatMoney(state.game.minBet),
              max: formatMoney(state.tableMax),
            })}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            {t("Every roll is made on our server from seeds you can check: see Provably fair.")}
          </p>
        </Sheet>
      ) : null}

      {sheet === "fair" ? (
        <Sheet title={t("Provably fair")} onClose={() => setSheet(null)}>
          <p>
            {t("Each roll comes from three things: our server seed, your client seed, and a nonce that counts your rolls. Before you roll, you see only a fingerprint (SHA-256 hash) of the server seed, so we can't change it without you noticing, and you can't work out the rolls. When you change seeds, the old server seed is shown, and you can check every roll it made, here or with any HMAC-SHA256 tool.")}
          </p>
          <h3 className="dice-sheet-heading">{t("Your seeds now")}</h3>
          <SeedLine label={t("Server seed (hashed)")} value={seed.serverSeedHash} onCopy={copy} />
          <SeedLine label={t("Client seed")} value={seed.clientSeed} onCopy={copy} />
          <SeedLine label={t("Rolls made with these seeds")} value={String(seed.nonce)} />
          <label className="dice-field dice-seed-edit">
            <small>{t("New client seed")}</small>
            <span className="dice-input">
              <input value={newClientSeed} maxLength={32} onChange={(event) => setNewClientSeed(event.target.value)} aria-label={t("New client seed")} />
            </span>
          </label>
          <button type="button" className="dice-go" disabled={locked || changingSeed} onClick={() => void changeSeed()}>
            {changingSeed ? t("Changing…") : t("Change seeds")}
          </button>

          {previousSeed ? (
            <>
              <h3 className="dice-sheet-heading">{t("Your last seeds, now shown")}</h3>
              <SeedLine label={t("Server seed")} value={previousSeed.serverSeed ?? ""} onCopy={copy} />
              <SeedLine label={t("Server seed (hashed)")} value={previousSeed.serverSeedHash} onCopy={copy} />
              <SeedLine label={t("Client seed")} value={previousSeed.clientSeed} onCopy={copy} />
              <SeedLine label={t("Rolls made with these seeds")} value={String(previousSeed.nonce)} />
            </>
          ) : null}

          <h3 className="dice-sheet-heading">{t("Check a roll")}</h3>
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
                <strong>{verified.roll === null ? "—" : points(verified.roll)}</strong>
              </span>
              <span>
                <small>{t("Its hash")}</small>
                <code>{verified.hash}</code>
              </span>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("Paste a server seed that has been shown, its client seed and a nonce.")}</p>
          )}
          <p className="muted dice-formula">roll = ⌊ (HMAC_SHA256(serverSeed, clientSeed + &quot;:&quot; + nonce)[0..3] ÷ 2³²) × 10000 ⌋ ÷ 100</p>
        </Sheet>
      ) : null}

      {detail ? (
        <Sheet title={t("Roll details")} onClose={() => setDetail(null)}>
          <div className={`dice-detail-head${detail.won ? " is-win" : " is-loss"}`}>
            <strong>{detail.roll.toFixed(2)}</strong>
            <span>{detail.won ? t("Won {amount} at {multiplier}×", { amount: formatMoney(detail.win), multiplier: detail.multiplier.toFixed(4) }) : t("No win this time")}</span>
          </div>
          <div className="dice-detail-grid">
            <SeedLine label={t("Target")} value={detail.direction === "UNDER" ? t("under {target}", { target: detail.target.toFixed(2) }) : t("over {target}", { target: detail.target.toFixed(2) })} />
            <SeedLine label={t("Win chance")} value={`${detail.chance.toFixed(2)}%`} />
            <SeedLine label={t("Multiplier")} value={`${detail.multiplier.toFixed(4)}×`} />
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
                className="dice-go"
                onClick={() => {
                  setVerify({ serverSeed: detail.serverSeed ?? "", clientSeed: detail.clientSeed, nonce: String(detail.nonce) });
                  setDetail(null);
                  setSheet("fair");
                }}
              >
                {t("Check this roll")}
              </button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("The server seed is shown once you change seeds. Then you can check this roll.")}</p>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal card casino-rules dice-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function SeedLine({ label, value, onCopy }: { label: string; value: string; onCopy?: (text: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="dice-seed-line">
      <small>{label}</small>
      <span>
        <code>{value}</code>
        {onCopy && value ? (
          <button type="button" className="dice-copy" onClick={() => onCopy(value)} aria-label={t("Copy")} title={t("Copy")}>
            ⧉
          </button>
        ) : null}
      </span>
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
