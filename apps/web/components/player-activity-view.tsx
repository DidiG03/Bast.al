"use client";

import { useState } from "react";
import { formatMoney } from "../lib/format";
import type { CasinoGameKey, PlayerActivity } from "../lib/api";
import { playerOutcome, Stat } from "./commission-views";
import { useI18n } from "./i18n-provider";
import { HelpTip } from "./help-tip";

const FIRST_RESULTS = 10;

const DATE_TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

function odds(value: number | null): string {
  return value === null ? "" : ` @ ${value.toFixed(2)}`;
}

/** Green when the Player lost (the team made money), red when they won. */
function highlightFor(net: number, staked: number): "good" | "bad" | undefined {
  if (staked === 0 || net === 0) return undefined;
  return net > 0 ? "good" : "bad";
}

/** Each Casino game's name, as its lobby tile shows it. */
const GAME_NAMES: Record<CasinoGameKey, string> = {
  slot: "Sizzling Hot",
  book: "Book of Ra",
  roulette: "Roulette",
  blackjack: "Blackjack",
  mines: "Mines",
  penalty: "Penalty",
  plinko: "Plinko",
  dice: "Dice",
  keno: "Keno",
  coinflip: "Coin Flip",
  scratch: "Scratch Cards",
};

export function PlayerActivityView({ data }: { data: PlayerActivity }) {
  const { t, tn, ts, date } = useI18n();
  const when = (value: string | null) => (value ? date(value, DATE_TIME) : "");
  const { summary, open, recent, casino } = data;
  const gameName = (game: CasinoGameKey) => t(GAME_NAMES[game] ?? game);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? recent : recent.slice(0, FIRST_RESULTS);
  const periods: Array<[string, typeof summary.thisWeek]> = [
    [t("This week"), summary.thisWeek],
    [t("Last 30 days"), summary.last30Days],
    [t("All time"), summary.allTime],
  ];
  return (
    <>
      <div className="report-grid">
        {periods.map(([label, totals]) => (
          <Stat
            key={label}
            label={label}
            help="Did this Player win or lose money in this time? “Lost” is good for the team; “Won” means the team paid out more than it took."
            value={totals.bets === 0 && totals.casinoRounds === 0 ? t("No bets") : playerOutcome(totals, t)}
            hint={`${tn(totals.bets, "{count} bet · {amount} staked", "{count} bets · {amount} staked", { amount: formatMoney(totals.staked) })}${totals.casinoRounds > 0 ? ` · ${tn(totals.casinoRounds, "{count} casino round", "{count} casino rounds")}` : ""}`}
            highlight={highlightFor(totals.net, totals.staked)}
          />
        ))}
        <Stat label={t("Open bets")} help="Bets on matches that are not finished yet, and the money on them." value={String(open.count)} hint={t("{amount} at stake", { amount: formatMoney(open.staked) })} />
      </div>

      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{t("Open bets")}<HelpTip text="This Player's bets that are still waiting for the match to finish." /></h2>
          <span className="muted">{t("{amount} at stake", { amount: formatMoney(open.staked) })}</span>
        </div>
        {open.casino.length > 0 ? (
          <div className="report-list">
            {open.casino.map((round) => (
              <div className="report-list-row" key={round.game}>
                <div>
                  <strong>{gameName(round.game)}</strong>
                  <span className="muted">
                    {round.freeSpins === null ? t("Round in play, started {when}", { when: when(round.startedAt) }) : tn(round.freeSpins, "{count} free spin still to play", "{count} free spins still to play")}
                  </span>
                </div>
                <span className="commission-amount">{round.freeSpins === null ? formatMoney(round.staked) : t("Free")}</span>
              </div>
            ))}
          </div>
        ) : null}
        {open.bets.length === 0 ? (
          open.casino.length === 0 ? <p className="muted" style={{ margin: 0 }}>{t("No bets waiting on a result.")}</p> : null
        ) : (
          <div className="report-list">
            {open.bets.map((bet) => (
              <div className="report-list-row" key={bet.id}>
                <div>
                  <strong>{bet.description ? ts(bet.description) : t("Bet")}</strong>
                  <span className="muted">
                    {t("Placed {when}", { when: when(bet.placedAt) })}
                    {odds(bet.odds)}
                  </span>
                </div>
                <span className="commission-amount">{formatMoney(bet.stake)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>
            {t("Casino")}
            <HelpTip text="This Player's Casino games in the last 30 days: how many rounds they played, what they staked and what was paid back. Each game keeps one line a day in their money history." />
          </h2>
          <span className="muted">{t("Last 30 days")}</span>
        </div>
        {casino.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No Casino play in the last 30 days.")}</p>
        ) : (
          <div className="report-list">
            {casino.map((row) => (
              <div className="report-list-row" key={row.game}>
                <div>
                  <strong>{gameName(row.game)}</strong>
                  <span className="muted">
                    {tn(row.rounds, "{count} round", "{count} rounds")} · {t("{amount} staked", { amount: formatMoney(row.staked) })} · {t("{amount} paid out", { amount: formatMoney(row.paidOut) })} · {t("Last played {when}", { when: when(row.lastPlayed) })}
                  </span>
                </div>
                <span className={`commission-amount${row.net < 0 ? " is-bad" : ""}`}>{playerOutcome({ bets: 0, staked: row.staked, paidOut: row.paidOut, net: row.net }, t)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{t("Recent results")}<HelpTip text="This Player's finished bets, newest first: what they bet, and whether they won or lost." /></h2>
          <span className="muted">{t("Latest {count}", { count: recent.length })}</span>
        </div>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No settled bets yet.")}</p>
        ) : (
          <div className="report-list">
            {shown.map((bet) => {
              const result =
                bet.status === "WON" ? t("Won {amount}", { amount: formatMoney(bet.payout - bet.stake) }) : bet.status === "LOST" ? t("Lost {amount}", { amount: formatMoney(bet.stake) }) : t("Refunded");
              return (
                <div className="report-list-row" key={bet.id}>
                  <div>
                    <strong>{bet.description ? ts(bet.description) : t("Bet")}</strong>
                    <span className="muted">
                      {t("{amount} staked", { amount: formatMoney(bet.stake) })}
                      {odds(bet.odds)} · {when(bet.settledAt)}
                    </span>
                  </div>
                  <span className={`commission-amount bet-result bet-result-${bet.status.toLowerCase()}`}>{result}</span>
                </div>
              );
            })}
          </div>
        )}
        {recent.length > FIRST_RESULTS ? (
          <button type="button" className="secondary" onClick={() => setShowAll(!showAll)}>
            {showAll ? t("Show fewer") : t("Show all {count}", { count: recent.length })}
          </button>
        ) : null}
      </section>
    </>
  );
}
