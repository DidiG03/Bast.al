"use client";

import { useEffect, useRef, useState } from "react";
import { HouseCabinet, HouseHistory, HousePage, RulesSheet, StakeChips, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { useCasinoSession } from "./use-casino-session";
import type { CrashMove, CrashRecord, CrashRound, CrashState } from "../lib/api";
import { formatMoney } from "../lib/format";

/** How often the page asks the server where the round stands while it climbs. */
const CHECK_MS = 500;

/** The curve so far, for the graph: the multiplier over the seconds since the start. */
function Curve({ seconds, growth, crashed }: { seconds: number; growth: number; crashed: boolean }) {
  const span = Math.max(8, seconds * 1.15);
  const top = Math.max(2, Math.exp(growth * 1000 * span) * 1.05);
  const points: string[] = [];
  const steps = 60;
  for (let i = 0; i <= steps; i++) {
    const s = (seconds * i) / steps;
    const m = Math.exp(growth * 1000 * s);
    points.push(`${(s / span) * 300},${150 - ((m - 1) / (top - 1)) * 140}`);
  }
  return (
    <svg className={`crash-curve${crashed ? " is-crashed" : ""}`} viewBox="0 0 300 150" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points.join(" ")} fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Crash for a Player: a multiplier climbs until it crashes; cash out before it does. */
export function CrashGame() {
  useCasinoSession("crash", "Crash");
  const { t } = useI18n();
  const toast = useToast();
  const g = useHouseGame<CrashState>("/casino/crash");
  const [round, setRound] = useState<CrashRound | null>(null);
  const [auto, setAuto] = useState("");
  const [display, setDisplay] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [rules, setRules] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** The server's clock minus this one, ms. */
  const offset = useRef(0);
  const checking = useRef(false);

  const adopt = (next: CrashRound) => {
    offset.current = Date.parse(next.serverNow) - Date.now();
    setRound(next);
  };

  if (g.state && !loaded) {
    setLoaded(true);
    if (g.state.round) adopt(g.state.round);
  }

  const growth = g.state?.game.growth ?? 0.00006;
  const playing = round?.phase === "PLAY";

  // The climb, drawn every frame from the server's start time.
  useEffect(() => {
    if (!playing || !round) return;
    let frame = 0;
    const started = Date.parse(round.startedAt);
    const tick = () => {
      const ms = Date.now() + offset.current - started;
      setElapsed(Math.max(0, ms / 1000));
      setDisplay(Math.floor(Math.exp(growth * Math.max(0, ms)) * 100) / 100);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, round, growth]);

  // The server decides when it crashes (or cashes out by itself): asked twice a second.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(async () => {
      if (checking.current) return;
      checking.current = true;
      const move = await g.send<CrashMove>("check", {}, { idempotent: false });
      checking.current = false;
      if (move && move.round.phase !== "PLAY") finish(move);
    }, CHECK_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  function finish(move: CrashMove) {
    adopt(move.round);
    g.setBalance(move.balance);
    setDisplay(move.round.at ?? move.round.crash ?? 1);
    g.tally(move.round.bet, move.round.payout);
    if (move.round.phase === "WON") slotSound.win((move.round.at ?? 0) >= 5);
    else slotSound.explosion();
    g.setState((current) =>
      current
        ? { ...current, recent: [{ id: `${Date.now()}`, bet: move.round.bet, win: move.round.payout, round: { game: "crash" as const, phase: move.round.phase as "WON" | "LOST", crash: move.round.crash ?? 0, at: move.round.at, auto: move.round.auto, payout: move.round.payout }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 30) }
        : current,
    );
  }

  async function start() {
    if (!g.state || g.busy || g.stakeProblem) return;
    const autoValue = auto.trim() ? Number(auto.replace(",", ".")) : null;
    if (autoValue !== null && (!Number.isFinite(autoValue) || autoValue < g.state.game.minAuto)) {
      toast.error(t("Set the automatic cash-out to {min}× or more, or leave it empty.", { min: g.state.game.minAuto.toFixed(2) }));
      return;
    }
    g.setBusy(true);
    slotSound.unlock();
    const move = await g.send<CrashMove>("start", { bet: g.stake, auto: autoValue });
    g.setBusy(false);
    if (!move) return;
    slotSound.spinStart();
    if (move.round.phase !== "PLAY") finish(move);
    else {
      adopt(move.round);
      g.setBalance(move.balance);
    }
  }

  async function cashOut() {
    if (g.busy || !playing) return;
    g.setBusy(true);
    const move = await g.send<CrashMove>("cashout");
    g.setBusy(false);
    if (move) finish(move);
  }

  if (!g.state) return <PageLoading label="Loading the Casino" />;
  const state = g.state;
  const crashed = round?.phase === "LOST";
  const shownMultiplier = playing ? display : round ? (round.at ?? round.crash ?? 1) : 1;
  const history = state.recent.map((row) => row.round).filter((r): r is CrashRecord => r !== null);

  return (
    <HousePage
      title="Crash"
      intro={t("The multiplier climbs until it crashes. Cash out before it does.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <HouseCabinet
          game="crash"
          title="Crash"
          balance={g.balance}
          visit={g.visit}
          onRules={() => setRules(true)}
          stage={
            <div className="crash-stage" aria-live="polite">
              <div className="crash-history" aria-label={t("Last crash points")}>
                {history.slice(0, 12).map((r, i) => (
                  <span key={i} className={r.crash >= 2 ? "is-high" : "is-low"}>
                    {r.crash.toFixed(2)}×
                  </span>
                ))}
              </div>
              <div className={`crash-screen${crashed ? " is-crashed" : round?.phase === "WON" ? " is-won" : ""}`}>
                {playing || round ? <Curve seconds={playing ? elapsed : Math.log(Math.max(1, shownMultiplier)) / (growth * 1000)} growth={growth} crashed={crashed} /> : null}
                <div className="crash-multiplier">
                  <strong>{shownMultiplier.toFixed(2)}×</strong>
                  <span>
                    {playing
                      ? round?.auto
                        ? t("Cashes out by itself at {auto}×", { auto: round.auto.toFixed(2) })
                        : t("Cash out before it crashes")
                      : crashed
                        ? t("Crashed at {at}×", { at: (round?.crash ?? 1).toFixed(2) })
                        : round?.phase === "WON"
                          ? t("Cashed out at {at}× · crashed at {crash}× · You won {amount}", { at: (round.at ?? 1).toFixed(2), crash: (round.crash ?? 1).toFixed(2), amount: formatMoney(round.payout) })
                          : t("Place a bet to start")}
                  </span>
                </div>
              </div>
            </div>
          }
          controls={
            playing && round ? (
              <button type="button" className="dice-go is-cashout crash-cashout" disabled={g.busy} onClick={() => void cashOut()}>
                {t("Cash out {amount}", { amount: formatMoney(Math.floor(round.bet * display * 100) / 100) })}
              </button>
            ) : (
              <>
                <StakeChips bets={state.game.bets} tableMax={state.tableMax} stake={g.stake} onStake={g.setStake} disabled={g.busy} />
                <label className="dice-field">
                  <small>{t("Automatic cash-out (optional)")}</small>
                  <span className="dice-input">
                    <input value={auto} placeholder="—" inputMode="decimal" disabled={g.busy} onChange={(event) => setAuto(event.target.value)} aria-label={t("Automatic cash-out (optional)")} />
                    <em aria-hidden="true">×</em>
                  </span>
                </label>
                <button type="button" className="dice-go" disabled={g.busy || !!g.stakeProblem} onClick={() => void start()}>
                  {t("Bet {amount}", { amount: formatMoney(g.stake) })}
                </button>
                {g.stakeProblem ? <p className="dice-problem">{g.stakeProblem}</p> : null}
              </>
            )
          }
        />
      }
      history={
        <HouseHistory<CrashRecord>
          title="Your last rounds"
          help="Your newest Crash rounds. They're also in My money, as one Crash line for each day."
          empty="No rounds yet."
          rows={state.recent}
          describe={(record) => ({
            head: record ? (record.phase === "WON" ? t("Cashed out at {at}×", { at: (record.at ?? 1).toFixed(2) }) : t("Crashed at {at}×", { at: record.crash.toFixed(2) })) : "—",
            detail: record ? t("crashed at {crash}×", { crash: record.crash.toFixed(2) }) : "",
          })}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <p>{t("Place a bet and the multiplier starts climbing from 1.00×. It crashes at a point nobody can see. Cash out before it crashes and you're paid your stake times the multiplier at that moment; if it crashes first, the stake is lost.")}</p>
            <p>{t("You can set an automatic cash-out: the round cashes out by itself as soon as it reaches that multiplier, if it gets there.")}</p>
            <p>{t("The crash point is drawn when the round starts, and it can crash at 1.00× straight away. It goes up to {max}×.", { max: state.game.maxMultiplier })}</p>
            <p>{t("The server's clock decides: a cash-out pays the multiplier when it reaches the server. A round left alone plays itself out.")}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
