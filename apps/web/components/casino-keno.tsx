"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SeedLine, Sheet, ShieldIcon } from "./fair-play";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { apiFetch, newIdempotencyKey, type DiceSeed, type DiceSeedChange, type KenoPlayResult, type KenoRound, type KenoState } from "../lib/api";
import { sha256Hex } from "../lib/dice";
import { drawFromSeeds, quickPick, times } from "../lib/keno";
import { formatMoney, formatStake } from "../lib/format";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

/** How long each ball takes to come out. Autoplay draws faster. */
const BALL_MS = 110;
const AUTO_BALL_MS = 40;
/** The pause between autoplay rounds. */
const AUTO_GAP_MS = 450;
/** A quick pick with nothing picked yet picks this many. */
const QUICK_PICK = 5;

type Verify = { serverSeed: string; clientSeed: string; nonce: string };

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
/** ALL typed by the Player, or NaN. Whole cents only. */
function parseMoney(text: string): number {
  const value = Number(text.replace(",", ".").replace(/[$\s]/g, ""));
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? Math.round(value * 100) / 100 : Number.NaN;
}

/** Keno for a Player: pick 1 to 10 numbers, 20 of 80 are drawn, and the hits pay. Every draw can be checked from its seeds. */
export function KenoGame() {
  const { getToken } = useAuth();
  const { t, tn, ts, date } = useI18n();
  const toast = useToast();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<KenoState | null>(null);
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(100);
  const [picks, setPicks] = useState<number[]>([]);
  /** The round on the board, and how many of its balls are out so far. */
  const [round, setRound] = useState<KenoRound | null>(null);
  const [shownBalls, setShownBalls] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [autoCount, setAutoCount] = useState("10");
  const [stopProfit, setStopProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [auto, setAuto] = useState<{ done: number; total: number | null; profit: number } | null>(null);
  /** This visit's rounds and profit. */
  const [visit, setVisit] = useState({ rounds: 0, profit: 0, wins: 0 });
  const [recent, setRecent] = useState<KenoRound[]>([]);
  const [seed, setSeed] = useState<DiceSeed | null>(null);
  const [previousSeed, setPreviousSeed] = useState<DiceSeed | null>(null);
  const [sheet, setSheet] = useState<"rules" | "fair" | null>(null);
  const [detail, setDetail] = useState<KenoRound | null>(null);
  const [newClientSeed, setNewClientSeed] = useState("");
  const [changingSeed, setChangingSeed] = useState(false);
  const [verify, setVerify] = useState<Verify>({ serverSeed: "", clientSeed: "", nonce: "0" });
  const [verified, setVerified] = useState<{ drawn: number[] | null; hash: string } | null>(null);
  const [soundOn, setSoundOn] = useState(true);

  const balanceRef = useRef(0);
  balanceRef.current = balance;
  /** The picks as of the last tap, so quick taps each build on the one before. */
  const picksRef = useRef<number[]>([]);
  const autoStop = useRef(false);
  const reducedMotion = useRef(false);
  /** Bumped by each new draw, so a draw still running stops when the next one starts. */
  const drawToken = useRef(0);

  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => {
    reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return () => {
      autoStop.current = true;
      drawToken.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<KenoState>("/casino/keno", token);
    setState(next);
    setBalance(next.balance);
    setRecent(next.recent);
    setSeed(next.seed);
    setPreviousSeed(next.previousSeed);
    setNewClientSeed(next.seed.clientSeed);
    // Keep the stake if it's still one of the bets and within the Player's max stake; otherwise the biggest that is.
    const allowed = next.game.bets.filter((value) => value <= next.tableMax);
    setBet((current) => (allowed.includes(current) ? current : (allowed.filter((value) => value <= current).pop() ?? allowed[0] ?? next.game.bets[0])));
    // Back where they left off: the last round's numbers, its draw on the board.
    const last = next.recent[0];
    if (last) {
      picksRef.current = last.picks;
      setPicks(last.picks);
      setRound(last);
      setShownBalls(last.drawn.length);
    }
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy && !auto) setBalance(event.balance);
  });

  const pays = state && picks.length > 0 ? state.game.pays[String(picks.length)] : null;
  const stakeProblem = (() => {
    if (!state) return null;
    if (picks.length === 0) return t("Pick 1 to 10 numbers on the board.");
    if (bet > state.tableMax) return t("The most a round can cost you is {amount}.", { amount: formatMoney(state.tableMax) });
    if (bet > balance) return t("Your balance is too low for this stake.");
    return null;
  })();
  const locked = busy || auto !== null;
  const drawing = round !== null && shownBalls < round.drawn.length;

  /** Takes the balls out one at a time, each with a tick or, on one of the Player's numbers, a pop. Resolves when they're all out. */
  const drawBalls = useCallback(async (next: KenoRound, ballMs: number | null) => {
    const token = ++drawToken.current;
    setRound(next);
    if (ballMs === null || document.hidden) {
      setShownBalls(next.drawn.length);
      return;
    }
    setShownBalls(0);
    let hits = 0;
    for (let index = 0; index < next.drawn.length; index++) {
      await sleep(ballMs);
      if (drawToken.current !== token) return;
      const hit = next.picks.includes(next.drawn[index]);
      if (hit) hits += 1;
      slotSound.kenoBall(hit, hits);
      setShownBalls(index + 1);
    }
  }, []);

  /** One round with the numbers and bet on the table. Returns the result, or null if it didn't go through. */
  const playOnce = useCallback(
    async (fast: boolean): Promise<KenoPlayResult | null> => {
      if (!state || state.closed) return null;
      if (stakeProblem || bet > balanceRef.current + 1e-9) {
        if (stakeProblem) toast.error(stakeProblem);
        return null;
      }
      slotSound.unlock();
      slotSound.click();
      let response: KenoPlayResult;
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        const body = JSON.stringify({ bet, picks });
        response = await apiFetch<KenoPlayResult>("/casino/keno/play", token, { method: "POST", body, idempotencyKey: newIdempotencyKey() });
      } catch (err) {
        toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
        return null;
      }
      const next = response.round;
      // The stake leaves straight away; the win arrives once the last ball is out.
      setBalance(Math.round((balanceRef.current - next.bet) * 100) / 100);
      await drawBalls(next, reducedMotion.current ? null : fast ? AUTO_BALL_MS : BALL_MS);
      slotSound.kenoResult(next.multiplier);
      setBalance(response.balance);
      setSeed(response.seed);
      setRecent((rows) => [next, ...rows].slice(0, 20));
      setVisit((current) => ({ rounds: current.rounds + 1, wins: current.wins + (next.win > 0 ? 1 : 0), profit: Math.round((current.profit + next.win - next.bet) * 100) / 100 }));
      return response;
    },
    [state, stakeProblem, bet, picks, getToken, t, ts, toast, drawBalls],
  );

  async function playManual() {
    if (locked) return;
    setBusy(true);
    try {
      await playOnce(false);
    } finally {
      setBusy(false);
    }
  }

  async function startAuto() {
    if (locked || !state) return;
    if (stakeProblem) {
      toast.error(stakeProblem);
      return;
    }
    const count = autoCount.trim() === "" || Number(autoCount) === 0 ? null : Math.floor(Number(autoCount));
    if (count !== null && (!Number.isFinite(count) || count < 1 || count > 1000)) {
      toast.error(t("Set from 1 to 1,000 rounds, or 0 to keep going until you stop."));
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
      const response = await playOnce(true);
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
      await sleep(reducedMotion.current ? 120 : AUTO_GAP_MS);
    }
    setAuto(null);
  }

  /** Picking or unpicking a number clears the last draw off the board. */
  function changePicks(next: number[]) {
    if (locked) return;
    drawToken.current += 1;
    setRound(null);
    setShownBalls(0);
    picksRef.current = next;
    setPicks(next);
  }

  function toggle(number: number) {
    if (locked || !state) return;
    const current = picksRef.current;
    if (current.includes(number)) {
      changePicks(current.filter((pick) => pick !== number));
      slotSound.click();
      return;
    }
    if (current.length >= state.game.maxPicks) {
      toast.info(t("You can pick up to {count} numbers.", { count: state.game.maxPicks }));
      return;
    }
    changePicks([...current, number].sort((a, b) => a - b));
    slotSound.click();
  }

  // Space presses the main button on a computer: a round, or autoplay's start and stop. Not while typing or with a sheet open.
  const mainAction = useRef<() => void>(() => undefined);
  mainAction.current = () => {
    if (mode === "manual") void playManual();
    else if (auto) autoStop.current = true;
    else void startAuto();
  };
  const sheetOpen = sheet !== null || detail !== null;
  const sheetOpenRef = useRef(sheetOpen);
  sheetOpenRef.current = sheetOpen;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
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
      const drawn = verify.clientSeed && Number.isInteger(nonce) && nonce >= 0 ? await drawFromSeeds(verify.serverSeed, verify.clientSeed, nonce) : null;
      if (current) setVerified({ drawn, hash });
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
      const change = await apiFetch<DiceSeedChange>("/casino/keno/seed", token, { method: "POST", body: JSON.stringify(clientSeed ? { clientSeed } : {}) });
      setSeed(change.seed);
      setPreviousSeed(change.previousSeed);
      setNewClientSeed(change.seed.clientSeed);
      // Rounds made with the old pair can be checked now.
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

  const out = round ? round.drawn.slice(0, shownBalls) : [];
  const hitsSoFar = round ? out.filter((number) => round.picks.includes(number)).length : 0;
  const settled = round && !drawing ? round : null;
  const bets = state.game.bets.filter((value) => value <= state.tableMax);

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Keno")}</h1>
          <p className="muted report-subtitle">{t("Pick up to 10 numbers. 20 of the 80 are drawn, and the more of yours come out, the more you win. Played with your balance.")}</p>
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
        <section ref={cabinet} className={`dice-cabinet keno-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={t("Keno")}>
          <header className="slot-marquee dice-marquee keno-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">{t("Keno")}</span>
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
            <div className="dice-stage keno-stage">
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
                  <small>{t("Rounds won")}</small>
                  <strong>
                    {visit.wins} / {visit.rounds}
                  </strong>
                </span>
              </div>

              <div className="keno-board" role="group" aria-label={t("The board: pick up to {count} numbers", { count: state.game.maxPicks })}>
                {Array.from({ length: state.game.numbers }, (_, index) => index + 1).map((number) => {
                  const picked = picks.includes(number);
                  const drawn = out.includes(number);
                  const latest = drawing && out[out.length - 1] === number;
                  const className = ["keno-cell", picked ? "is-picked" : "", drawn ? "is-drawn" : "", picked && drawn ? "is-hit" : "", latest ? "is-latest" : ""].filter(Boolean).join(" ");
                  return (
                    <button
                      type="button"
                      key={number}
                      className={className}
                      aria-pressed={picked}
                      aria-label={picked && drawn ? t("{number}: yours, drawn", { number }) : picked ? t("{number}: yours", { number }) : drawn ? t("{number}: drawn", { number }) : String(number)}
                      disabled={locked}
                      onClick={() => toggle(number)}
                    >
                      {number}
                    </button>
                  );
                })}
              </div>

              <div className={`keno-result${settled ? (settled.win > 0 ? " is-win" : " is-loss") : ""}`} aria-live="polite">
                {round ? (
                  drawing ? (
                    <span>
                      {t("Ball {count} of {total}", { count: shownBalls, total: round.drawn.length })} · {tn(hitsSoFar, "{count} hit", "{count} hits")}
                    </span>
                  ) : settled && settled.win > 0 ? (
                    <strong>
                      {t("{hits} of {picks} hit: won {amount}", { hits: settled.hits.length, picks: settled.picks.length, amount: formatMoney(settled.win) })} ({times(settled.multiplier)})
                    </strong>
                  ) : (
                    <span>{t("{hits} of {picks} hit: no win this time", { hits: settled?.hits.length ?? 0, picks: settled?.picks.length ?? picks.length })}</span>
                  )
                ) : (
                  <span className="keno-result-hint">{picks.length === 0 ? t("Tap numbers on the board, or use Quick pick.") : tn(picks.length, "{count} number picked. Press Play.", "{count} numbers picked. Press Play.")}</span>
                )}
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
                <div className="keno-bets" role="radiogroup" aria-label={t("Stake")}>
                  {bets.map((value) => (
                    <button
                      type="button"
                      key={value}
                      role="radio"
                      aria-checked={bet === value}
                      className={bet === value ? "is-on" : undefined}
                      disabled={locked}
                      onClick={() => {
                        setBet(value);
                        slotSound.chip();
                      }}
                    >
                      {formatStake(value)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="keno-pick-row">
                <span>
                  <small>{t("Your numbers")}</small>
                  <strong>
                    {picks.length} / {state.game.maxPicks}
                  </strong>
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={locked}
                  onClick={() => {
                    changePicks(quickPick(picksRef.current.length || QUICK_PICK));
                    slotSound.chip();
                  }}
                >
                  {t("Quick pick")}
                </button>
                <button type="button" className="secondary" disabled={locked || picks.length === 0} onClick={() => changePicks([])}>
                  {t("Clear")}
                </button>
              </div>

              <div className="keno-pays" aria-label={t("What {count} numbers pay", { count: picks.length })}>
                {pays ? (
                  pays
                    .map((pay, hits) => ({ pay, hits }))
                    .filter(({ pay }) => pay > 0)
                    .reverse()
                    .map(({ pay, hits }) => (
                      <div key={hits} className={`keno-pay${settled && settled.picks.length === picks.length && settled.hits.length === hits ? " is-landed" : ""}`}>
                        <span>{tn(hits, "{count} hit", "{count} hits")}</span>
                        <span>{times(pay)}</span>
                        <strong>{formatStake(Math.floor((Math.round(bet * 100) * Math.round(pay * 10)) / 10) / 100)}</strong>
                      </div>
                    ))
                ) : (
                  <p className="muted">{t("Pick numbers to see what they pay.")}</p>
                )}
              </div>

              {mode === "auto" ? (
                <div className="dice-auto">
                  <label className="dice-field">
                    <small>{t("Number of rounds")}</small>
                    <span className="dice-input">
                      <input value={autoCount} inputMode="numeric" disabled={locked} onChange={(event) => setAutoCount(event.target.value)} aria-label={t("Number of rounds")} />
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
                      {auto.total === null ? t("Round {done}", { done: auto.done }) : t("Round {done} of {total}", { done: auto.done, total: auto.total })} ·{" "}
                      <span className={auto.profit < 0 ? "is-loss" : auto.profit > 0 ? "is-win" : undefined}>
                        {auto.profit > 0 ? "+" : ""}
                        {formatMoney(auto.profit)}
                      </span>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {mode === "manual" ? (
                <button type="button" className="dice-go" disabled={busy || !!stakeProblem} onClick={() => void playManual()}>
                  {busy ? t("Drawing…") : t("Play")}
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
              {stakeProblem ? <p className="dice-problem">{stakeProblem}</p> : <p className="dice-hint">{mode === "manual" ? t("Press Space to play.") : t("Press Space to start or stop.")}</p>}
            </div>
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last rounds")}
          <HelpTip text="Your newest Keno rounds. Tap one to see its draw and its seeds, and check it. They're also in My money, as one Keno line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No rounds yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <button type="button" className="report-list-row dice-row" key={row.id} onClick={() => setDetail(row)}>
                <div>
                  <strong className={row.win > 0 ? "is-good" : "is-bad"}>{t("{hits} of {picks}", { hits: row.hits.length, picks: row.picks.length })}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {times(row.multiplier)} · {t("{amount} stake", { amount: formatMoney(row.bet) })}
                  </span>
                </div>
                <strong className={row.win > 0 ? undefined : "is-bad"}>{formatMoney(row.win)}</strong>
              </button>
            ))}
          </div>
        )}
      </section>

      {sheet === "rules" ? (
        <Sheet title={t("Pays and rules")} onClose={() => setSheet(null)}>
          <p>{t("Pick 1 to 10 numbers from 1 to 80, tap them on the board or use Quick pick. Each round draws 20 of the 80 numbers, each as likely as any other. What you win depends on how many numbers you picked and how many of them were drawn: the stake times the pay below, with cents rounded down.")}</p>
          <p>
            {t("A round costs {min} to {max}, never more than your max stake. Autoplay plays your numbers again and again, and stops after the number of rounds you set, when it reaches your stop on profit or stop on loss, or when you stop it.", {
              min: formatMoney(state.game.bets[0]),
              max: formatMoney(state.tableMax),
            })}
          </p>
          <div className="keno-paytable">
            {Object.entries(state.game.pays).map(([count, row]) => (
              <div key={count} className="keno-paytable-row">
                <strong>{tn(Number(count), "{count} number", "{count} numbers")}</strong>
                <span>
                  {row
                    .map((pay, hits) => ({ pay, hits }))
                    .filter(({ pay }) => pay > 0)
                    .map(({ pay, hits }) => `${hits} → ${times(pay)}`)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            {t("Every draw is made on our server from seeds you can check: see Provably fair.")}
          </p>
        </Sheet>
      ) : null}

      {sheet === "fair" ? (
        <Sheet title={t("Provably fair")} onClose={() => setSheet(null)}>
          <p>
            {t("Each draw comes from three things: our server seed, your client seed, and a nonce that counts your rounds. Before you play, you see only a fingerprint (SHA-256 hash) of the server seed, so we can't change it without you noticing, and you can't work out the draws. When you change seeds, the old server seed is shown, and you can check every draw it made. Keno and Dice use the same seeds.")}
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
          <button type="button" className="dice-go" disabled={locked || changingSeed} onClick={() => void changeSeed()}>
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

          <h3 className="dice-sheet-heading">{t("Check a draw")}</h3>
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
                <small>{t("Numbers drawn, in order")}</small>
                <strong className="keno-verify-numbers">{verified.drawn === null ? "—" : verified.drawn.join(", ")}</strong>
              </span>
              <span>
                <small>{t("Its hash")}</small>
                <code>{verified.hash}</code>
              </span>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("Paste a server seed that has been shown, its client seed and a nonce.")}</p>
          )}
          <p className="muted dice-formula">ball i = pot[ ⌊ (HMAC_SHA256(serverSeed, clientSeed + &quot;:&quot; + nonce + &quot;:&quot; + i)[0..3] ÷ 2³²) × numbers left ⌋ ], i = 0…19</p>
        </Sheet>
      ) : null}

      {detail ? (
        <Sheet title={t("Round details")} onClose={() => setDetail(null)}>
          <div className={`dice-detail-head${detail.win > 0 ? " is-win" : " is-loss"}`}>
            <strong>{t("{hits} of {picks}", { hits: detail.hits.length, picks: detail.picks.length })}</strong>
            <span>{detail.win > 0 ? t("Won {amount} at {multiplier}", { amount: formatMoney(detail.win), multiplier: times(detail.multiplier) }) : t("No win this time")}</span>
          </div>
          <div className="keno-board is-small" aria-hidden="true">
            {Array.from({ length: state.game.numbers }, (_, index) => index + 1).map((number) => {
              const picked = detail.picks.includes(number);
              const drawn = detail.drawn.includes(number);
              return (
                <span key={number} className={["keno-cell", picked ? "is-picked" : "", drawn ? "is-drawn" : "", picked && drawn ? "is-hit" : ""].filter(Boolean).join(" ")}>
                  {number}
                </span>
              );
            })}
          </div>
          <div className="dice-detail-grid">
            <SeedLine label={t("Your numbers")} value={detail.picks.join(", ")} />
            <SeedLine label={t("Numbers drawn, in order")} value={detail.drawn.join(", ")} />
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
                {t("Check this draw")}
              </button>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{t("The server seed is shown once you change seeds. Then you can check this draw.")}</p>
          )}
        </Sheet>
      ) : null}
    </div>
  );
}
