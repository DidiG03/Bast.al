import type { BetLeg } from "../lib/api";

const LEG_MARK: Record<NonNullable<BetLeg["result"]>, string> = { WON: "Won", LOST: "Lost", VOID: "Void" };
const dateTimeFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** An accumulator's picks with each one's match and result. */
export function BetLegs({ legs }: { legs: BetLeg[] }) {
  return (
    <ol className="bet-legs">
      {legs.map((leg, index) => {
        const event = leg.event;
        const score = event.result ?? (event.homeScore !== null && event.awayScore !== null && event.status !== "UPCOMING" ? { home: event.homeScore, away: event.awayScore } : null);
        let state = leg.result ? LEG_MARK[leg.result] : "";
        if (!leg.result) {
          if (event.status === "LIVE") state = "Live";
          else if (event.status === "POSTPONED") state = "Postponed";
          else if (event.status === "COMPLETED") state = "Settling";
          else state = dateTimeFormat.format(new Date(event.startsAt));
        }
        return (
          <li key={index} className={`bet-leg${leg.result ? ` is-${leg.result.toLowerCase()}` : ""}`}>
            <div className="bet-leg-main">
              <strong>{leg.name}</strong>
              <span className="muted">
                {leg.market} · {event.name}
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

