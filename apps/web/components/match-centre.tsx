"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, type BetEvent, type LineupPlayer, type MatchCentreData, type MatchCentreResponse, type MatchMoment, type TeamLineup } from "../lib/api";
import { msg } from "../lib/i18n/core";
import { usePolling } from "../lib/use-polling";
import { useI18n } from "./i18n-provider";
import { LoadingSpinner } from "./loading-spinner";

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

/** The feed's names for its numbers, as Players read them. One it adds later shows under its own name. */
const STAT_LABEL: Record<string, string> = {
  expected_goals: msg("Expected goals (xG)"),
  "Ball Possession": msg("Possession"),
  "Total Shots": msg("Total shots"),
  "Shots on Goal": msg("Shots on target"),
  "Shots off Goal": msg("Shots off target"),
  "Blocked Shots": msg("Blocked shots"),
  "Shots insidebox": msg("Shots inside the box"),
  "Shots outsidebox": msg("Shots outside the box"),
  "Corner Kicks": msg("Corners"),
  Offsides: msg("Offsides"),
  Fouls: msg("Fouls"),
  "Yellow Cards": msg("Yellow cards"),
  "Red Cards": msg("Red cards"),
  "Goalkeeper Saves": msg("Goalkeeper saves"),
  "Total passes": msg("Passes"),
  "Passes accurate": msg("Accurate passes"),
  "Passes %": msg("Pass accuracy"),
};
const PERCENT = new Set(["Ball Possession", "Passes %"]);

/** The numbers to show: the feed's full list, or, for a centre saved before there was one, the few it had. */
function statsOf(centre: MatchCentreData): Array<{ type: string; home: number; away: number }> {
  if (centre.stats) return centre.stats;
  const legacy: Array<[string, [number, number] | null]> = [
    ["Ball Possession", centre.possession],
    ["Shots on Goal", centre.shotsOnTarget],
    ["Corner Kicks", centre.corners],
    ["Yellow Cards", centre.yellow],
    ["Red Cards", centre.red],
  ];
  return legacy.flatMap(([type, pair]) => (pair ? [{ type, home: pair[0], away: pair[1] }] : []));
}

/** Home and away names from "Home v Away". */
function teamNames(name: string, t: (text: string) => string): [string, string] {
  const parts = name.split(" v ");
  return parts.length === 2 ? [parts[0], parts[1]] : [t("Home"), t("Away")];
}

type CentreTab = "summary" | "stats" | "lineups";

/**
 * A match's timeline, numbers and team sheets, under tabs: what happened
 * (newest first), every number the feed has as bars, home against away, and
 * the line-ups once they're out. A tab with nothing in it isn't offered.
 */
export function MatchCentreBody({ centre, homeName, awayName }: { centre: MatchCentreData; homeName: string; awayName: string }) {
  const { t } = useI18n();
  const stats = statsOf(centre);
  const tabs = (
    [
      ["summary", t("Summary"), centre.moments.length > 0],
      ["stats", t("Stats"), stats.length > 0],
      ["lineups", t("Line-ups"), Boolean(centre.lineups)],
    ] as Array<[CentreTab, string, boolean]>
  ).filter(([, , has]) => has);
  const [chosen, setChosen] = useState<CentreTab | null>(null);
  const tab = tabs.find(([key]) => key === chosen)?.[0] ?? tabs[0]?.[0] ?? null;
  if (!tab) return null;
  return (
    <div className="match-centre-body">
      {tabs.length > 1 ? (
        <div className="match-centre-tabs" role="tablist" aria-label={t("Match updates")}>
          {tabs.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "is-active" : undefined} onClick={() => setChosen(key)}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "summary" ? <Moments moments={centre.moments} homeName={homeName} awayName={awayName} /> : null}
      {tab === "stats" ? <StatBars stats={stats} homeName={homeName} awayName={awayName} /> : null}
      {tab === "lineups" && centre.lineups ? <Lineups home={centre.lineups.home} away={centre.lineups.away} homeName={homeName} awayName={awayName} /> : null}
    </div>
  );
}

function Moments({ moments, homeName, awayName }: { moments: MatchMoment[]; homeName: string; awayName: string }) {
  const { t } = useI18n();
  return (
    <ol className="match-centre-moments">
      {moments.map((moment, index) => {
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
  );
}

/** Each number as two bars meeting in the middle; the side ahead is lit. */
function StatBars({ stats, homeName, awayName }: { stats: Array<{ type: string; home: number; away: number }>; homeName: string; awayName: string }) {
  const { t } = useI18n();
  const shown = (type: string, value: number) => (type === "expected_goals" ? value.toFixed(2) : `${value}${PERCENT.has(type) ? "%" : ""}`);
  return (
    <div className="match-stats">
      <div className="match-stats-teams" aria-hidden="true">
        <span>{homeName}</span>
        <span>{awayName}</span>
      </div>
      <dl>
        {stats.map(({ type, home, away }) => {
          const total = home + away;
          const homeShare = total > 0 ? (home / total) * 100 : 0;
          const awayShare = total > 0 ? (away / total) * 100 : 0;
          const label = STAT_LABEL[type] ? t(STAT_LABEL[type]) : type;
          return (
            <div key={type} className="match-stat">
              <dt>{label}</dt>
              <dd aria-label={t("{home}: {homeValue}, {away}: {awayValue}", { home: homeName, homeValue: shown(type, home), away: awayName, awayValue: shown(type, away) })}>
                <span className={`match-stat-value${home > away ? " is-ahead" : ""}`} aria-hidden="true">
                  {shown(type, home)}
                </span>
                <span className="match-stat-bars" aria-hidden="true">
                  <span className="match-stat-bar is-home">
                    <span className={home > away ? "is-ahead" : undefined} style={{ width: `${homeShare}%` }} />
                  </span>
                  <span className="match-stat-bar is-away">
                    <span className={away > home ? "is-ahead" : undefined} style={{ width: `${awayShare}%` }} />
                  </span>
                </span>
                <span className={`match-stat-value${away > home ? " is-ahead" : ""}`} aria-hidden="true">
                  {shown(type, away)}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function Lineups({ home, away, homeName, awayName }: { home: TeamLineup; away: TeamLineup; homeName: string; awayName: string }) {
  return (
    <div className="match-lineups">
      <TeamSheet sheet={home} name={homeName} />
      <TeamSheet sheet={away} name={awayName} />
    </div>
  );
}

function TeamSheet({ sheet, name }: { sheet: TeamLineup; name: string }) {
  const { t } = useI18n();
  const row = (player: LineupPlayer, index: number) => (
    <li key={`${player.name}-${index}`}>
      <span className="match-lineup-number">{player.number ?? ""}</span>
      <span className="match-lineup-name">{player.name}</span>
      {player.pos ? <span className="match-lineup-pos">{player.pos}</span> : null}
    </li>
  );
  return (
    <section className="match-lineup">
      <h4>
        {name}
        {sheet.formation ? <span className="muted"> · {sheet.formation}</span> : null}
      </h4>
      <ol>{sheet.starting.map(row)}</ol>
      {sheet.bench.length > 0 ? (
        <>
          <h5>{t("Substitutes")}</h5>
          <ol>{sheet.bench.map(row)}</ol>
        </>
      ) : null}
      {sheet.coach ? <p className="muted match-lineup-coach">{t("Coach: {name}", { name: sheet.coach })}</p> : null}
    </section>
  );
}

/** The feed has something to show for this match yet. */
function hasAnything(centre: MatchCentreData | null | undefined): centre is MatchCentreData {
  return Boolean(centre && (centre.moments.length > 0 || statsOf(centre).length > 0 || centre.lineups));
}

/**
 * The match updates under a bet: a summary line (minute, corners, red cards)
 * that opens onto the timeline and numbers. Opens by itself while the match
 * is live; collapsed otherwise. Nothing shows until the feed has something.
 */
export function MatchCentre({ event, compact = false }: { event: BetEvent; compact?: boolean }) {
  const { t } = useI18n();
  const centre = event.centre;
  if (!hasAnything(centre)) return null;
  const [homeName, awayName] = teamNames(event.name, t);
  const live = event.status === "LIVE";
  const minute = live ? (event.period === "HT" ? t("Half time") : event.elapsed !== null && event.elapsed !== undefined ? `${event.elapsed}'` : t("Live")) : event.status === "COMPLETED" ? t("Full time") : "";
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
      <MatchCentreBody centre={centre} homeName={homeName} awayName={awayName} />
    </details>
  );
}

/**
 * A football match's stats, loaded when opened from its card: the timeline,
 * every number and the team sheets. Kept up to date while the match is live.
 */
export function MatchStatsPanel({ eventId, name, live }: { eventId: string; name: string; live: boolean }) {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const [data, setData] = useState<MatchCentreResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      setData(await apiFetch<MatchCentreResponse>(`/odds/events/${encodeURIComponent(eventId)}/centre`, token));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [getToken, eventId]);
  useEffect(() => {
    void load();
  }, [load]);
  usePolling(() => void load(), 20_000, live || data?.status === "LIVE");
  const [homeName, awayName] = teamNames(name, t);

  if (!data) {
    return (
      <div className="match-stats-panel">
        {failed ? (
          <p className="muted">{t("Couldn't load the stats. Try again in a moment.")}</p>
        ) : (
          <div className="loading-state">
            <LoadingSpinner label="Loading stats" size="small" />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="match-stats-panel">
      {hasAnything(data.centre) ? (
        <MatchCentreBody centre={data.centre} homeName={homeName} awayName={awayName} />
      ) : (
        <p className="muted">{data.status === "UPCOMING" ? t("Stats show here once the match starts. Line-ups come about an hour before kick-off.") : t("No stats for this match yet.")}</p>
      )}
    </div>
  );
}
