"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { HelpTip } from "./help-tip";
import { PenaltyScene } from "./penalty-scene";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { useGameKeys } from "./use-game-keys";
import { apiFetch, type PenaltyDirection, type PenaltyRoundView, type PenaltyState, type PenaltyStepResult } from "../lib/api";
import { formatMoney, formatStake } from "../lib/format";
import { useIdempotencyKey } from "../lib/use-idempotency-key";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
/** After the kick is chosen: the taker strikes the ball, it meets the keeper or the net, and the whole move is over, in ms (see penalty-scene.tsx). */
const STRIKE_MS = 560;
const CONTACT_MS = 960;
const MOVE_MS = 2250;

/** Penalty for a Player: aim, the keeper dives, cash out before a save. */
export function PenaltyGame() {
  const { getToken } = useAuth();
  const { t, ts, tn, date } = useI18n();
  const toast = useToast();
  const startKey = useIdempotencyKey();
  const stepKey = useIdempotencyKey();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<PenaltyState | null>(null);
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(0);
  const [round, setRound] = useState<PenaltyRoundView | null>(null);
  const [recent, setRecent] = useState<PenaltyState["recent"]>([]);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [call, setCall] = useState<"goal" | "save" | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => () => {
    timers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<PenaltyState>("/casino/penalty", token);
    setState(next);
    setBalance(next.balance);
    setRecent(next.recent);
    setRound(next.round ?? next.recent[0] ?? null);
    setBet((current) => current || Math.min(next.game.bets[1] ?? next.game.bets[0], next.tableMax));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy) setBalance(event.balance);
  });

  const playing = round?.phase === "PLAY";

  function later(ms: number, run: () => void) {
    timers.current.push(window.setTimeout(run, ms));
  }

  async function send(path: string, body: object | null, key: ReturnType<typeof useIdempotencyKey>) {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const text = body ? JSON.stringify(body) : "";
    const result = await apiFetch<PenaltyStepResult>(path, token, { method: "POST", ...(text ? { body: text } : {}), idempotencyKey: key.keyFor(path, text) });
    key.done();
    return result;
  }

  function show(next: PenaltyRoundView, balanceNext: number) {
    const previous = round;
    const kicked = Boolean(previous && previous.phase === "PLAY" && next.kicks.length > previous.kicks.length);
    setFresh(kicked);
    setRound(next);
    setBalance(balanceNext);
    slotSound.unlock();
    if (kicked) {
      const scored = next.kicks[next.kicks.length - 1]?.goal === true;
      setCall(null);
      later(STRIKE_MS, () => slotSound.kick());
      later(CONTACT_MS, () => setCall(scored ? "goal" : "save"));
      later(CONTACT_MS + 1300, () => setCall(null));
      later(CONTACT_MS, () => {
        if (!scored) {
          slotSound.save();
          return;
        }
        slotSound.net();
        if (next.phase === "WON") {
          slotSound.win(next.capped || next.multiplier >= 10);
          slotSound.coins(Math.min(1400, 400 + next.cashout * 20));
        } else slotSound.cheer();
      });
    } else if (next.phase === "WON") {
      slotSound.win(next.capped || next.multiplier >= 10);
      slotSound.coins(Math.min(1400, 400 + next.cashout * 20));
    } else if (next.phase === "PLAY" && next.goals === 0) slotSound.whistle();
    if (next.phase !== "PLAY") {
      setRecent((rows) => [{ ...next, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...rows].slice(0, 10));
    }
  }

  async function start() {
    if (!state || playing || busy) return;
    slotSound.unlock();
    setBusy(true);
    setCall(null);
    try {
      const result = await send("/casino/penalty/start", { bet }, startKey);
      show(result.round, result.balance);
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function shoot(aim: PenaltyDirection) {
    if (!playing || busy) return;
    slotSound.unlock();
    setBusy(true);
    try {
      const result = await send("/casino/penalty/kick", { aim }, stepKey);
      show(result.round, result.balance);
      // The next kick waits until the keeper is down, the ball has stopped and the taker is back on his mark.
      await new Promise((resolve) => window.setTimeout(resolve, MOVE_MS));
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function cashOut() {
    if (!playing || busy || (round?.goals ?? 0) === 0) return;
    slotSound.unlock();
    setBusy(true);
    try {
      const result = await send("/casino/penalty/cashout", null, stepKey);
      show(result.round, result.balance);
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  useGameKeys(rulesOpen);

  if (!state) return <PageLoading label="Loading the Casino" />;

  const last = round?.kicks.at(-1) ?? null;
  const message = (() => {
    if (!round || (round.phase !== "PLAY" && round.goals === 0 && recent.length === 0)) return t("Pick your stake, then start.");
    if (round.phase === "PLAY" && round.goals === 0) return t("Aim left, center or right.");
    if (round.phase === "PLAY") return t("Next goal {multiplier}×. Cash out {amount}.", { multiplier: round.nextMultiplier?.toFixed(2) ?? round.multiplier.toFixed(2), amount: formatMoney(round.cashout) });
    if (round.phase === "LOST") return t("Saved! The stake is lost.");
    if (round.capped) return t("That's the most a round pays: {amount}.", { amount: formatMoney(round.cashout) });
    return t("Cashed out {amount} at {multiplier}×.", { amount: formatMoney(round.cashout), multiplier: round.multiplier.toFixed(2) });
  })();

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Penalty")}</h1>
          <p className="muted report-subtitle">{t("Take the penalties, cash out before the keeper saves one. Played with your balance.")}</p>
          <p className="game-keys-hint">{t("Keys: Space starts a round or cashes out, and ← ↑ → shoot left, centre and right.")}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setRulesOpen(true)}>
          {t("Pays and rules")}
        </button>
      </div>

      {state.closed && !playing ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <section ref={cabinet} className={`penalty-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={t("Penalty")}>
          <header className="slot-marquee penalty-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">{t("Penalty")}</span>
            <button
              type="button"
              className="slot-fullscreen penalty-sound"
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
            <button type="button" className="slot-fullscreen penalty-rules" onClick={() => setRulesOpen(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
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

          <div className="penalty-stage">
            <div className="mines-readout" aria-live="polite">
              <span>
                <small>{t("Goals")}</small>
                <strong>{round?.goals ?? 0}</strong>
              </span>
              <span>
                <small>{t("Multiplier")}</small>
                <strong>{`${(playing && round.goals === 0 ? 1 : round?.multiplier ?? 1).toFixed(2)}×`}</strong>
              </span>
              <span>
                <small>{playing ? t("Cash out") : t("Balance")}</small>
                <strong>{playing ? formatMoney(round.cashout) : formatMoney(balance)}</strong>
              </span>
            </div>
            <p className={`mines-message${round?.phase === "WON" ? " is-win" : ""}${round?.phase === "LOST" ? " is-loss" : ""}`}>{message}</p>

            <PenaltyScene last={last} fresh={fresh} call={call} canShoot={playing && !busy} onShoot={(side) => void shoot(side)} kickNumber={round?.kicks.length ?? 0} />
          </div>

          <div className="mines-controls">
            <div className="mines-picks" role="radiogroup" aria-label={t("Stake")}>
              {state.game.bets.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`mines-pick${bet === value ? " is-on" : ""}`}
                  aria-pressed={bet === value}
                  disabled={playing || busy || value > state.tableMax || value > balance}
                  onClick={() => setBet(value)}
                >
                  {formatStake(value)}
                </button>
              ))}
            </div>
            {playing ? (
              <button type="button" className="mines-go" data-key="Space" disabled={busy || round.goals === 0} onClick={() => void cashOut()}>
                {round.goals === 0 ? t("Score a goal") : t("Cash out {amount}", { amount: formatMoney(round.cashout) })}
              </button>
            ) : (
              <button type="button" className="mines-go" data-key="Space" disabled={busy || bet <= 0 || bet > balance || bet > state.tableMax} onClick={() => void start()}>
                {t("Start {amount}", { amount: formatStake(bet) })}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last rounds")}
          <HelpTip text="Your newest Penalty rounds. They're also in My money, as one Penalty line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No rounds yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <div className="report-list-row" key={row.id}>
                <div>
                  <strong>{tn(row.goals, "{count} goal", "{count} goals")}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {row.phase === "LOST" ? t("Saved") : `${row.multiplier.toFixed(2)}×`}
                  </span>
                </div>
                <strong className={row.phase === "LOST" ? "is-bad" : undefined}>{row.phase === "LOST" ? formatMoney(0) : formatMoney(row.cashout)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen ? (
        <div className="modal-backdrop" onClick={() => setRulesOpen(false)}>
          <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="penalty-rules-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 id="penalty-rules-title">{t("Pays and rules")}</h2>
              <button type="button" className="modal-close secondary" onClick={() => setRulesOpen(false)} aria-label={t("Close")}>
                ×
              </button>
            </div>
            <p>
              {t("You aim left, center or right, and the keeper dives one of those ways. A different way is a goal and raises what the round pays. The same way is a save and loses the stake. Cash out after the first goal, or keep taking them. The round ends on its own if it reaches {times} times the stake.", { times: state.game.maxWin.toLocaleString() })}
            </p>
            <p>
              {t("The first {full} goals pay the fair chance of having scored that many, less {edge}%. Every goal after that multiplies what the round pays by {step} instead of the fair 1.5. Cents are rounded down. The stake is {min} to {max}, and never more than your max stake. A round left for an hour is cashed out, or the stake comes back if you hadn't scored.", {
                edge: Math.round((100 - state.game.payoutRate) * 10) / 10,
                full: state.game.fullPriceGoals,
                step: state.game.laterStep,
                min: formatMoney(state.game.bets[0]),
                max: formatMoney(state.game.bets[state.game.bets.length - 1]),
              })}
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
