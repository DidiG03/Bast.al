"use client";

import type { BetLeg } from "../lib/api";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";

const LEG_MARK: Record<NonNullable<BetLeg["result"]>, string> = { WON: msg("Won"), LOST: msg("Lost"), VOID: msg("Void") };

/** An accumulator's picks with each one's match and result. */
export function BetLegs({ legs }: { legs: BetLeg[] }) {
  const { t, ts, date } = useI18n();
  return (
    <ol className="bet-legs">
      {legs.map((leg, index) => {
        const event = leg.event;
        const score = event.result ?? (event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING" ? { home: event.homeScore, away: event.awayScore } : null);
        let state = leg.result ? t(LEG_MARK[leg.result]) : "";
        if (!leg.result) {
          if (event.status === "LIVE") state = t("Live");
          else if (event.status === "POSTPONED") state = t("Postponed");
          else if (event.status === "COMPLETED") state = t("Settling");
          else state = date(event.startsAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        }
        return (
          <li key={index} className={`bet-leg${leg.result ? ` is-${leg.result.toLowerCase()}` : ""}`}>
            <div className="bet-leg-main">
              <strong>{ts(leg.name)}</strong>
              <span className="muted">
                {ts(leg.market)} · {event.name}
                {score ? ` · ${score.home}–${score.away}` : ""}
              </span>
              {leg.voidReason ? <span className="muted">{leg.voidReason}</span> : null}
            </div>
            <div className="bet-leg-side">
              <span>{leg.odds.toFixed(2)}</span>
              <span className={`bet-leg-state${leg.result ? ` bet-status-${leg.result.toLowerCase()}` : " muted"}`}>{state}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

