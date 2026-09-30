"use client";

import { useState } from "react";
import { formatMoney } from "../lib/format";
import type { PlayerActivity } from "../lib/api";
import { playerOutcome, Stat } from "./commission-views";
import { useI18n } from "./i18n-provider";
import { HelpTip } from "./help-tip";

const FIRST_RESULTS = 10;

const DATE_TIME: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };

function odds(value: number | null): string {
  return value === null ? "" : ` @ ${value.toFixed(2)}`;
}

/** Green when the Player lost (the team made money), red when they won. */
function highlightFor(net: number, bets: number): "good" | "bad" | undefined {
  if (bets === 0 || net === 0) return undefined;
  return net > 0 ? "good" : "bad";
}

export function PlayerActivityView({ data }: { data: PlayerActivity }) {
  const { t, tn, ts, date } = useI18n();
  const when = (value: string | null) => (value ? date(value, DATE_TIME) : "");
  const { summary, open, recent } = data;
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
            value={totals.bets === 0 ? t("No bets") : playerOutcome(totals, t)}
            hint={tn(totals.bets, "{count} bet · {amount} staked", "{count} bets · {amount} staked", { amount: formatMoney(totals.staked) })}
            highlight={highlightFor(totals.net, totals.bets)}
          />
        ))}
        <Stat label={t("Open bets")} help="Bets on matches that are not finished yet, and the money on them." value={String(open.count)} hint={t("{amount} at stake", { amount: formatMoney(open.staked) })} />
      </div>

      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>{t("Open bets")}<HelpTip text="This Player's bets that are still waiting for the match to finish." /></h2>
          <span className="muted">{t("{amount} at stake", { amount: formatMoney(open.staked) })}</span>
        </div>
        {open.bets.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No bets waiting on a result.")}</p>
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
