"use client";

import { useState, type CSSProperties } from "react";
import { ChoiceRow, HouseCabinet, HouseHistory, HousePage, RulesSheet, StakeChips, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import type { TowerLevel, TowerMove, TowerRound, TowerState } from "../lib/api";
import { formatMoney } from "../lib/format";

/** Tower for a Player: climb floor by floor, picking a safe door on each, and cash out before a trap. */
export function TowerGame() {
  useCasinoSession("tower", "Tower");
  const { t } = useI18n();
  const g = useHouseGame<TowerState>("/casino/tower");
  const [level, setLevel] = useState<TowerLevel>("MEDIUM");
  const [round, setRound] = useState<TowerRound | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState(false);

  if (g.state && !loaded) {
    setLoaded(true);
    setRound(g.state.round);
    if (g.state.round) setLevel(g.state.round.level);
  }

  function apply(move: TowerMove) {
    setRound(move.round);
    g.setBalance(move.balance);
    if (move.round.phase !== "PLAY") {
      g.tally(move.round.bet, move.round.payout);
      if (move.round.phase === "WON") slotSound.win(move.round.multiplier >= 5);
      else slotSound.explosion();
      g.setState((current) => (current ? { ...current, recent: [{ id: `${Date.now()}`, bet: move.round.bet, win: move.round.payout, round: move.round, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) } : current));
    } else slotSound.coinPop(move.round.floors);
  }

  async function start() {
    if (!g.state || g.busy || g.stakeProblem) return;
    g.setBusy(true);
    slotSound.unlock();
    const move = await g.send<TowerMove>("start", { bet: g.stake, level });
    if (move) {
      setRound(move.round);
      g.setBalance(move.balance);
      slotSound.click();
    }
    g.setBusy(false);
  }

  async function open(door: number) {
    if (g.busy || round?.phase !== "PLAY") return;
    g.setBusy(true);
    const move = await g.send<TowerMove>("climb", { door });
    if (move) apply(move);
    g.setBusy(false);
  }

  async function cashOut() {
    if (g.busy) return;
    g.setBusy(true);
    const move = await g.send<TowerMove>("cashout");
    if (move) apply(move);
    g.setBusy(false);
  }

  if (!g.state) return <PageLoading label="Loading the Casino" />;
  const state = g.state;
  const shownLevel = round?.level ?? level;
  const { doors } = state.game.shapes[shownLevel];
  const ladder = state.game.ladders[shownLevel];
  const playing = round?.phase === "PLAY";
  const levelName = (value: TowerLevel) => ({ EASY: t("Easy"), MEDIUM: t("Medium"), HARD: t("Hard"), EXPERT: t("Expert") })[value];

  return (
    <HousePage
      title={t("Tower")}
      intro={t("Climb the tower one floor at a time. Pick a safe door on each floor; cash out before you hit a trap.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <HouseCabinet
          game="tower"
          title={t("Tower")}
          balance={g.balance}
          visit={g.visit}
          onRules={() => setRules(true)}
          stage={
            <div className="tower-stage" aria-live="polite">
              <div className="tower-grid" style={{ "--doors": doors } as CSSProperties}>
                {Array.from({ length: state.game.floors }, (_, i) => state.game.floors - 1 - i).map((floor) => {
                  const picked = round?.picks[floor];
                  const traps = round?.traps?.[floor] ?? null;
                  const current = playing && round && floor === round.picks.length;
                  return (
                    <div key={floor} className={`tower-floor${current ? " is-current" : ""}${round && floor < round.picks.length ? " is-climbed" : ""}`}>
                      <span className="tower-pay">{ladder[floor].toFixed(2)}×</span>
                      {Array.from({ length: doors }, (_, door) => {
                        const isPick = picked === door;
                        const isTrap = traps?.includes(door) ?? false;
                        const state = isPick ? (isTrap ? " is-trap" : " is-safe") : traps ? (isTrap ? " is-trap-shown" : " is-safe-shown") : "";
                        return (
                          <button type="button" key={door} className={`tower-door${state}`} disabled={!current || g.busy} onClick={() => void open(door)} aria-label={t("Floor {floor}, door {door}", { floor: floor + 1, door: door + 1 })}>
                            {isPick ? (isTrap ? "💥" : "💎") : traps ? (isTrap ? "💣" : "") : ""}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <p className={`house-result${round?.phase === "WON" ? " is-win" : round?.phase === "LOST" ? " is-loss" : ""}`}>
                {!round
                  ? t("Pick a difficulty and a stake, then start climbing.")
                  : round.phase === "WON"
                    ? t("Cashed out at {multiplier}× · You won {amount}", { multiplier: round.multiplier.toFixed(2), amount: formatMoney(round.payout) })
                    : round.phase === "LOST"
                      ? t("A trap · No win this time")
                      : round.floors === 0
                        ? t("Pick a door on the first floor.")
                        : t("Floor {floor} · cash out {amount} or climb to {next}×", { floor: round.floors, amount: formatMoney(round.cashOutNow), next: round.nextMultiplier?.toFixed(2) ?? "" })}
              </p>
            </div>
          }
          controls={
            playing && round ? (
              <button type="button" className="dice-go is-cashout" disabled={g.busy || round.floors === 0} onClick={() => void cashOut()}>
                {round.floors === 0 ? t("Climb a floor to cash out") : t("Cash out {amount}", { amount: formatMoney(round.cashOutNow) })}
              </button>
            ) : (
              <>
                <ChoiceRow label={t("Difficulty")} options={state.game.levels.map((value) => [value, levelName(value)] as [TowerLevel, string])} value={level} onChange={setLevel} disabled={g.busy} />
                <StakeChips bets={state.game.bets} tableMax={state.tableMax} stake={g.stake} onStake={g.setStake} disabled={g.busy} />
                <button type="button" className="dice-go" disabled={g.busy || !!g.stakeProblem} onClick={() => void start()}>
                  {round ? t("Climb again") : t("Start climbing")}
                </button>
                {g.stakeProblem ? <p className="dice-problem">{g.stakeProblem}</p> : null}
              </>
            )
          }
        />
      }
      history={
        <HouseHistory<TowerRound>
          title="Your last climbs"
          help="Your newest Tower climbs. They're also in My money, as one Tower line for each day."
          empty="No climbs yet."
          rows={state.recent}
          describe={(record) => ({ head: record ? (record.phase === "WON" ? `${record.multiplier.toFixed(2)}×` : t("A trap")) : "—", detail: record ? `${levelName(record.level)} · ${t("{count} floors", { count: record.floors })}` : "" })}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <p>{t("Pick a difficulty and a stake, then climb. Each floor has doors with traps behind some; open one door per floor, from the bottom up.")}</p>
            <p>{t("Easy: 4 doors, 1 trap. Medium: 3 doors, 1 trap. Hard: 2 doors, 1 trap. Expert: 3 doors, 2 traps.")}</p>
            <p>{t("A safe door takes you a floor higher and raises the multiplier; a trap loses the stake. Cash out after any floor; the top floor cashes out by itself.")}</p>
            <p>{t("The multiplier is {rate}% of the fair price of the floors climbed, so a climb pays back {rate}% on average. The traps are placed when you start and shown when the climb ends. A climb pays at most {max}× the stake.", { rate: state.game.payoutRate, max: state.game.maxWin })}</p>
            <p>{t("A climb left alone for 30 minutes is cashed out, or the stake comes back if no floor was climbed.")}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
