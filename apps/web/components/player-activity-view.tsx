"use client";

import { useState } from "react";
import { formatMoney } from "../lib/format";
import type { PlayerActivity } from "../lib/api";
import { playerOutcome, plural, Stat } from "./commission-views";

const FIRST_RESULTS = 10;

const dateTime = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function when(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : "";
}

function odds(value: number | null): string {
  return value === null ? "" : ` @ ${value.toFixed(2)}`;
}

/** Green when the Player lost (the team made money), red when they won. */
function highlightFor(net: number, bets: number): "good" | "bad" | undefined {
  if (bets === 0 || net === 0) return undefined;
  return net > 0 ? "good" : "bad";
}

export function PlayerActivityView({ data }: { data: PlayerActivity }) {
  const { summary, open, recent } = data;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? recent : recent.slice(0, FIRST_RESULTS);
  const periods: Array<[string, typeof summary.thisWeek]> = [
    ["This week", summary.thisWeek],
    ["Last 30 days", summary.last30Days],
    ["All time", summary.allTime],
  ];
  return (
    <>
      <div className="report-grid">
        {periods.map(([label, totals]) => (
          <Stat
            key={label}
            label={label}
            value={totals.bets === 0 ? "No bets" : playerOutcome(totals)}
            hint={`${plural(totals.bets, "bet")} · ${formatMoney(totals.staked)} staked`}
            highlight={highlightFor(totals.net, totals.bets)}
          />
        ))}
        <Stat label="Open bets" value={String(open.count)} hint={`${formatMoney(open.staked)} at stake`} />
      </div>

      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>Open bets</h2>
          <span className="muted">{formatMoney(open.staked)} at stake</span>
        </div>
        {open.bets.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No bets waiting on a result.</p>
        ) : (
          <div className="report-list">
            {open.bets.map((bet) => (
              <div className="report-list-row" key={bet.id}>
                <div>
                  <strong>{bet.description ?? "Bet"}</strong>
                  <span className="muted">Placed {when(bet.placedAt)}{odds(bet.odds)}</span>
                </div>
                <span className="commission-amount">{formatMoney(bet.stake)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="tree-header">
          <h2 style={{ margin: 0 }}>Recent results</h2>
          <span className="muted">Latest {recent.length}</span>
        </div>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No settled bets yet.</p>
        ) : (
          <div className="report-list">
            {shown.map((bet) => {
              const result = bet.status === "WON" ? `Won ${formatMoney(bet.payout - bet.stake)}` : bet.status === "LOST" ? `Lost ${formatMoney(bet.stake)}` : "Refunded";
              return (
                <div className="report-list-row" key={bet.id}>
                  <div>
                    <strong>{bet.description ?? "Bet"}</strong>
                    <span className="muted">{formatMoney(bet.stake)} staked{odds(bet.odds)} · {when(bet.settledAt)}</span>
                  </div>
                  <span className={`commission-amount bet-result bet-result-${bet.status.toLowerCase()}`}>{result}</span>
                </div>
              );
            })}
          </div>
        )}
        {recent.length > FIRST_RESULTS ? (
          <button type="button" className="secondary" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show all ${recent.length}`}
          </button>
        ) : null}
      </section>
    </>
  );
}
