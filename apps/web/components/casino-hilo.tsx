"use client";

import { useState } from "react";
import { HouseCabinet, HouseHistory, HousePage, PlayingCardView, RulesSheet, StakeChips, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import type { HiloGuess, HiloMove, HiloRecord, HiloRound, HiloState } from "../lib/api";
import { formatMoney } from "../lib/format";

/** Hi-Lo for a Player: guess whether the next card is higher or lower, and cash out when you like. */
export function HiloGame() {
  useCasinoSession("hilo", "Hi-Lo");
  const { t } = useI18n();
  const g = useHouseGame<HiloState>("/casino/hilo");
  const [round, setRound] = useState<HiloRound | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState(false);

  // The round in play when the page opens.
  if (g.state && !loaded) {
    setLoaded(true);
    setRound(g.state.round);
  }

  function finished(move: HiloMove) {
    setRound(move.round);
    g.setBalance(move.balance);
    if (move.round.phase !== "PLAY") {
      g.tally(move.round.bet, move.round.payout);
      if (move.round.phase === "WON") slotSound.win(move.round.multiplier >= 5);
      else slotSound.gambleLose();
      g.setState((current) =>
        current ? { ...current, recent: [{ id: `${Date.now()}`, bet: move.round.bet, win: move.round.payout, round: { game: "hilo" as const, phase: move.round.phase as "WON" | "LOST", steps: move.round.steps, payout: move.round.payout }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) } : current,
      );
    }
  }

  async function start() {
    if (!g.state || g.busy || g.stakeProblem) return;
    g.setBusy(true);
    slotSound.unlock();
    const move = await g.send<HiloMove>("start", { bet: g.stake });
    if (move) {
      slotSound.cardFlip();
      setRound(move.round);
      g.setBalance(move.balance);
    }
    g.setBusy(false);
  }

  async function guess(choice: HiloGuess) {
    if (g.busy) return;
    g.setBusy(true);
    const move = await g.send<HiloMove>("guess", { guess: choice });
    if (move) {
      slotSound.cardFlip();
      finished(move);
    }
    g.setBusy(false);
  }

  async function cashOut() {
    if (g.busy) return;
    g.setBusy(true);
    const move = await g.send<HiloMove>("cashout");
    if (move) finished(move);
    g.setBusy(false);
  }

  if (!g.state) return <PageLoading label="Loading the Casino" />;
  const state = g.state;
  const playing = round?.phase === "PLAY";
  const current = round ? round.steps[round.steps.length - 1].card : null;
  const trail = round ? round.steps.slice(-8, -1) : [];

  return (
    <HousePage
      title="Hi-Lo"
      intro={t("Guess if the next card is higher or lower. Every right guess raises the multiplier; cash out when you like.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <HouseCabinet
          game="hilo"
          title="Hi-Lo"
          balance={g.balance}
          visit={g.visit}
          onRules={() => setRules(true)}
          stage={
            <div className="hilo-stage" aria-live="polite">
              <div className="hilo-trail" aria-label={t("Cards so far")}>
                {trail.map((step, i) => (
                  <PlayingCardView key={i} card={step.card} small />
                ))}
              </div>
              <div className="hilo-current">
                <PlayingCardView card={current} back={!current} highlight={round?.phase === "LOST" ? "loss" : round?.phase === "WON" ? "win" : null} />
              </div>
              <div className="hilo-multiplier">
                <small>{t("Multiplier")}</small>
                <strong>{round ? `${round.multiplier.toFixed(2)}×` : "—"}</strong>
              </div>
              <p className={`house-result${round?.phase === "WON" ? " is-win" : round?.phase === "LOST" ? " is-loss" : ""}`}>
                {!round
                  ? t("Pick a stake and start: a card is turned.")
                  : round.phase === "WON"
                    ? t("Cashed out · You won {amount}", { amount: formatMoney(round.payout) })
                    : round.phase === "LOST"
                      ? t("Wrong guess · No win this time")
                      : round.canCashOut
                        ? t("Cash out now for {amount}, or guess again.", { amount: formatMoney(round.cashOutNow) })
                        : t("Higher or same, or lower or same?")}
              </p>
            </div>
          }
          controls={
            playing && round ? (
              <>
                <div className="hilo-guesses">
                  <button type="button" className="hilo-guess is-higher" disabled={g.busy || round.higher.chance === 100} onClick={() => void guess("HIGHER")}>
                    <strong>▲ {t("Higher or same")}</strong>
                    <small>
                      {round.higher.chance}% · {round.higher.multiplier.toFixed(2)}×
                    </small>
                  </button>
                  <button type="button" className="hilo-guess is-lower" disabled={g.busy || round.lower.chance === 100} onClick={() => void guess("LOWER")}>
                    <strong>▼ {t("Lower or same")}</strong>
                    <small>
                      {round.lower.chance}% · {round.lower.multiplier.toFixed(2)}×
                    </small>
                  </button>
                </div>
                <button type="button" className="secondary hilo-skip" disabled={g.busy} onClick={() => void guess("SKIP")}>
                  {t("Skip this card")}
                </button>
                <button type="button" className="dice-go is-cashout" disabled={g.busy || !round.canCashOut} onClick={() => void cashOut()}>
                  {round.canCashOut ? t("Cash out {amount}", { amount: formatMoney(round.cashOutNow) }) : t("Make a right guess to cash out")}
                </button>
              </>
            ) : (
              <>
                <StakeChips bets={state.game.bets} tableMax={state.tableMax} stake={g.stake} onStake={g.setStake} disabled={g.busy} />
                <button type="button" className="dice-go" disabled={g.busy || !!g.stakeProblem} onClick={() => void start()}>
                  {round ? t("Play again") : t("Start")}
                </button>
                {g.stakeProblem ? <p className="dice-problem">{g.stakeProblem}</p> : null}
              </>
            )
          }
        />
      }
      history={
        <HouseHistory<HiloRecord>
          title="Your last rounds"
          help="Your newest Hi-Lo rounds. They're also in My money, as one Hi-Lo line for each day."
          empty="No rounds yet."
          rows={state.recent}
          describe={(record) => {
            const rights = record ? record.steps.filter((step) => step.correct === true).length : 0;
            return { head: record ? (record.phase === "WON" ? t("Cashed out") : t("Wrong guess")) : "—", detail: t("{count} right guesses", { count: rights }) };
          }}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <p>{t("Start a round and a card is turned. Guess whether the next card is higher or the same, or lower or the same. Aces are low, kings high.")}</p>
            <p>{t("Every card is drawn as from an endless deck: each of the 13 ranks is as likely every time. The fewer ranks your guess wins on, the more it raises the multiplier.")}</p>
            <p>{t("A wrong guess loses the stake. After a right guess you can cash out: you're paid the stake times the multiplier. You can skip a card for free.")}</p>
            <p>{t("A round pays at most {max}× the stake.", { max: state.game.maxWin })}</p>
            <p>{t("A round left alone for 30 minutes is cashed out, or the stake comes back if no right guess was made.")}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
