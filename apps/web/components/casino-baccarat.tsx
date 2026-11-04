"use client";

import { useState, type ReactNode } from "react";
import { ChoiceRow, HouseCabinet, HouseHistory, HousePage, PlayingCardView, RulesSheet, StakeChips, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import type { BaccaratDeal, BaccaratHand, BaccaratRecord, BaccaratSide, BaccaratState } from "../lib/api";
import { formatMoney } from "../lib/format";

/** The pause between cards as they're dealt. */
const CARD_MS = 520;
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
/** What a side pays on a win, in times the stake, stake included. */
const PAYS: Record<BaccaratSide, string> = { PLAYER: "0.47:1", BANKER: "0.43:1", TIE: "7:1" };

/** Baccarat for a Player: bet on Player, Banker or Tie, and the cards are dealt by the rules. */
export function BaccaratGame() {
  useCasinoSession("baccarat", "Baccarat");
  const { t } = useI18n();
  const g = useHouseGame<BaccaratState>("/casino/baccarat");
  const [side, setSide] = useState<BaccaratSide>("PLAYER");
  /** The cards on the table so far, as they're dealt. */
  const [shown, setShown] = useState<{ player: BaccaratHand["player"]; banker: BaccaratHand["banker"] }>({ player: [], banker: [] });
  const [result, setResult] = useState<BaccaratDeal | null>(null);
  const [rules, setRules] = useState(false);

  const sideName = (value: BaccaratSide) => (value === "PLAYER" ? t("Player") : value === "BANKER" ? t("Banker") : t("Tie"));

  async function deal() {
    if (!g.state || g.busy || g.stakeProblem) return;
    g.setBusy(true);
    slotSound.unlock();
    setResult(null);
    setShown({ player: [], banker: [] });
    const response = await g.send<BaccaratDeal>("deal", { bet: g.stake, side });
    if (!response) {
      g.setBusy(false);
      return;
    }
    g.setBalance(Math.round((g.balance - response.bet) * 100) / 100);
    const { hand } = response;
    // The order a table deals: Player, Banker, Player, Banker, then the third cards.
    const order: Array<["player" | "banker", number]> = [["player", 0], ["banker", 0], ["player", 1], ["banker", 1]];
    if (hand.player[2]) order.push(["player", 2]);
    if (hand.banker[2]) order.push(["banker", 2]);
    for (const [who, index] of order) {
      if (!document.hidden) await sleep(CARD_MS);
      slotSound.cardDeal();
      setShown((current) => ({ ...current, [who]: hand[who].slice(0, index + 1) }));
    }
    if (!document.hidden) await sleep(300);
    setResult(response);
    g.setBalance(response.balance);
    g.tally(response.bet, response.win);
    if (response.win > response.bet) slotSound.win(side === "TIE");
    g.setState((current) => (current ? { ...current, recent: [{ id: response.id, bet: response.bet, win: response.win, round: { game: "baccarat" as const, side, ...hand }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) } : current));
    g.setBusy(false);
  }

  if (!g.state) return <PageLoading label="Loading the Casino" />;
  const state = g.state;
  const total = (cards: BaccaratHand["player"]) => cards.reduce((sum, card) => sum + (card.rank >= 10 ? 0 : card.rank), 0) % 10;
  const winner = result?.hand.winner ?? null;

  return (
    <HousePage
      title="Baccarat"
      intro={t("Bet on Player, Banker or Tie. The hand closer to 9 wins.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <HouseCabinet
          game="baccarat"
          title="Baccarat"
          balance={g.balance}
          visit={g.visit}
          onRules={() => setRules(true)}
          stage={
            <div className="baccarat-table" aria-live="polite">
              {(["player", "banker"] as const).map((who) => (
                <div key={who} className={`baccarat-hand${winner === who.toUpperCase() ? " is-winner" : ""}`}>
                  <div className="baccarat-hand-head">
                    <strong>{who === "player" ? t("Player") : t("Banker")}</strong>
                    <span className="baccarat-total">{shown[who].length ? total(shown[who]) : "–"}</span>
                  </div>
                  <div className="baccarat-cards">
                    {shown[who].length === 0 ? (
                      <>
                        <PlayingCardView back />
                        <PlayingCardView back />
                      </>
                    ) : (
                      shown[who].map((card, i) => <PlayingCardView key={i} card={card} />)
                    )}
                  </div>
                </div>
              ))}
              <p className={`house-result${result ? (result.win > result.bet ? " is-win" : result.win === result.bet ? "" : " is-loss") : ""}`}>
                {g.busy && !result
                  ? t("Dealing…")
                  : result
                    ? `${winner === "TIE" ? t("Tie") : t("{side} wins", { side: sideName(winner!) })} · ${result.win > result.bet ? t("You won {amount}", { amount: formatMoney(result.win) }) : result.win === result.bet ? t("Your stake comes back") : t("No win this time")}`
                    : t("Pick a side, then deal.")}
              </p>
            </div>
          }
          controls={
            <>
              <ChoiceRow
                label={t("Your bet")}
                options={state.game.sides.map((value) => [value, <span key={value} className="house-choice-two"><strong>{sideName(value)}</strong><small>{PAYS[value]}</small></span>] as [BaccaratSide, ReactNode])}
                value={side}
                onChange={setSide}
                disabled={g.busy}
              />
              <StakeChips bets={state.game.bets} tableMax={state.tableMax} stake={g.stake} onStake={g.setStake} disabled={g.busy} />
              <button type="button" className="dice-go" disabled={g.busy || !!g.stakeProblem} onClick={() => void deal()}>
                {g.busy ? t("Dealing…") : t("Deal")}
              </button>
              {g.stakeProblem ? <p className="dice-problem">{g.stakeProblem}</p> : null}
            </>
          }
        />
      }
      history={
        <HouseHistory<BaccaratRecord>
          title="Your last hands"
          help="Your newest Baccarat hands. They're also in My money, as one Baccarat line for each day."
          empty="No hands yet."
          rows={state.recent}
          describe={(round) => ({
            head: round ? `${round.playerTotal} – ${round.bankerTotal} · ${round.winner === "TIE" ? t("Tie") : t("{side} wins", { side: sideName(round.winner) })}` : "—",
            detail: round ? t("bet on {side}", { side: sideName(round.side) }) : "",
          })}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <p>{t("Bet on Player, Banker or Tie, then deal. Two hands are dealt from a fresh 8-deck shoe; the one whose total is closer to 9 wins.")}</p>
            <p>{t("Aces count 1, 2 to 9 their number, tens and pictures 0, and a hand counts only its last digit: 7 and 8 make 5.")}</p>
            <p>{t("A third card is drawn by the standard rules, nobody chooses: with 8 or 9 on two cards both stand; otherwise Player draws on 0 to 5, and Banker draws by its total and Player's third card.")}</p>
            <p>{t("Player pays 0.47 to 1, Banker 0.43 to 1, Tie 7 to 1. On a tie, Player and Banker bets get their stake back.")}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
