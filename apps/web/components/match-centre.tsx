"use client";

import type { BetEvent, MatchMoment } from "../lib/api";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";

const ICON: Record<MatchMoment["kind"], string> = {
  goal: "⚽",
  own_goal: "⚽",
  penalty: "⚽",
  missed_penalty: "✕",
  yellow: "🟨",
  red: "🟥",
  sub: "⇄",
  var: "VAR",
};

/** What each kind of moment is called, under the player's name. */
const KIND: Record<MatchMoment["kind"], string> = {
  goal: msg("Goal scored"),
  own_goal: msg("Own goal"),
  penalty: msg("Penalty goal"),
  missed_penalty: msg("Missed penalty"),
  yellow: msg("Yellow card"),
  red: msg("Red card"),
  sub: msg("Substitution"),
  var: msg("VAR check"),
};

/** The feed's VAR decisions we know how to say; anything else shows as the feed wrote it. */
const VAR_DECISION: Record<string, string> = {
  "Goal cancelled": msg("Goal ruled out"),
  "Goal confirmed": msg("Goal stands"),
  "Penalty confirmed": msg("Penalty given"),
  "Penalty cancelled": msg("No penalty"),
  "Card upgrade": msg("Card upgraded to red"),
  "Red card cancelled": msg("Red card taken back"),
};

/**
 * A match's live timeline and numbers under a bet on it: goals, cards,
 * substitutions and VAR, newest first, and the corners and cards so far.
 * Opens by itself while the match is live; collapsed otherwise. Football
 * matches with a bet on them only; nothing shows until the feed has something.
 */
export function MatchCentre({ event, compact = false }: { event: BetEvent; compact?: boolean }) {
  const { t } = useI18n();
  const centre = event.centre;
  if (!centre) return null;
  const known = centre.moments.length > 0 || centre.corners || centre.yellow || centre.red;
  if (!known) return null;
  const [homeName, awayName] = event.name.includes(" v ") ? event.name.split(" v ") : [t("Home"), t("Away")];
  const live = event.status === "LIVE";
  const minute = live ? (event.period === "HT" ? t("Half time") : event.elapsed !== null ? `${event.elapsed}'` : t("Live")) : event.status === "COMPLETED" ? t("Full time") : "";
  const rows: Array<[string, [number, number] | null, string?]> = [
    [t("Corners"), centre.corners],
    [t("Yellow cards"), centre.yellow],
    [t("Red cards"), centre.red],
    [t("Shots on target"), centre.shotsOnTarget],
    [t("Possession"), centre.possession, "%"],
  ];
  const shown = rows.filter(([, pair]) => pair !== null) as Array<[string, [number, number], string?]>;
  const reds = centre.red ? centre.red[0] + centre.red[1] : 0;
  return (
    <details className={`match-centre${compact ? " is-compact" : ""}`} open={live && !compact}>
      <summary>
        <span className="match-centre-title">
          {live ? <span className="live-dot" aria-hidden="true" /> : null}
          {t("Match updates")}
        </span>
        <span className="match-centre-peek">
          {minute ? <span>{minute}</span> : null}
          {centre.corners ? <span title={t("Corners")}>⚑ {centre.corners[0] + centre.corners[1]}</span> : null}
          {reds > 0 ? <span title={t("Red cards")}>🟥 {reds}</span> : null}
        </span>
      </summary>
      {shown.length > 0 ? (
        <table className="match-centre-stats">
          <thead>
            <tr>
              <th scope="col">{homeName}</th>
              <th scope="col">
                <span className="sr-only">{t("Match updates")}</span>
              </th>
              <th scope="col">{awayName}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(([label, [home, away], unit = ""]) => (
              <tr key={label}>
                <td className={home > away ? "is-ahead" : undefined}>
                  {home}
                  {unit}
                </td>
                <th scope="row">{label}</th>
                <td className={away > home ? "is-ahead" : undefined}>
                  {away}
                  {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {centre.moments.length > 0 ? (
        <ol className="match-centre-moments">
          {centre.moments.map((moment, index) => {
            const when = moment.extra ? `${moment.minute}+${moment.extra}'` : `${moment.minute}'`;
            const what =
              moment.kind === "var"
                ? moment.detail
                  ? VAR_DECISION[moment.detail]
                    ? t(VAR_DECISION[moment.detail])
                    : moment.detail
                  : t(KIND.var)
                : t(KIND[moment.kind]);
            const extra = moment.kind === "sub" && moment.other ? t("for {player}", { player: moment.other }) : (moment.kind === "goal" || moment.kind === "penalty") && moment.other ? t("assist {player}", { player: moment.other }) : null;
            return (
              <li key={index} className={`match-moment is-${moment.side} is-${moment.kind.replace("_", "-")}`}>
                <span className="match-moment-minute">{when}</span>
                <span className="match-moment-icon" aria-hidden="true">
                  {ICON[moment.kind]}
                </span>
                <span className="match-moment-text">
                  <strong>{moment.player ?? (moment.side === "home" ? homeName : awayName)}</strong>
                  <span className="muted">
                    {what}
                    {extra ? ` · ${extra}` : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </details>
  );
}
