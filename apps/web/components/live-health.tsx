"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { msg } from "../lib/i18n/core";
import { useI18n } from "./i18n-provider";
import { HelpTip } from "./help-tip";

type Share = number | null;
export type LiveHealthData = {
  days: number;
  overall: { openOfShown: Share; openOfAll: Share; pauses: number; averagePauseMs: number | null; freshReopens: number; livePicks: number; voidRate: Share };
  pausesByReason: Array<{ reason: string; pauses: number; averageMs: number | null; fresh: number }>;
  competitions: Array<{ competition: string; matches: number; openOfShown: Share; openOfAll: Share; pauses: number; averagePauseMs: number | null; livePicks: number; voidRate: Share; liveOff: boolean; noLiveCards: boolean; noLiveCorners: boolean }>;
  matches: Array<{ id: string; name: string; competition: string; live: boolean; openOfShown: Share; openOfAll: Share; pauses: number; averagePauseMs: number | null }>;
  liveLimits: { maxLagMs: number; slow: string[]; noCards: string[]; noCorners: string[] };
  lag?: { broken: boolean; ignored: number; competitions: Array<{ competition: string; goals: number; p95: number; median: number; gated: boolean }> };
  polling: {
    plan: { perDay: number | null; leftToday: number | null; perMinute: number | null; leftThisMinute: number | null };
    intervals: { boardMs: number | null; priorityMs: number | null; scoresMs: number | null };
    matches: Array<{ eventId: string; name: string; reads: number; everyMs: number | null; ageMs: number | null; ageMaxMs: number | null }>;
  };
};

const REFRESH_MS = 60_000;

/**
 * Super Admin: how much of the live board stays open, how long pauses after
 * goals and cards last, how many live picks are voided, which competitions
 * have live limits, and how the live polling is going (the feed plan, how
 * often each match is read and how far behind the bookmaker).
 */
export function LiveHealth() {
  const { getToken } = useAuth();
  const [days, setDays] = useState(1);
  const [data, setData] = useState<LiveHealthData | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const token = await getToken();
      if (!token) return;
      const next = await apiFetch<LiveHealthData>(`/odds/live-health?days=${days}`, token);
      if (!cancelled) setData(next);
    };
    void load().catch(() => undefined);
    const timer = window.setInterval(() => void load().catch(() => undefined), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [getToken, days]);
  return data ? <LiveHealthView data={data} days={days} onDays={setDays} /> : null;
}

/** The live health numbers themselves (LiveHealth loads them). */
export function LiveHealthView({ data, days, onDays }: { data: LiveHealthData; days: number; onDays: (days: number) => void }) {
  const { t, tn } = useI18n();
  const percent = (value: Share) => (value === null ? "–" : `${value}%`);
  const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);
  const count = (value: number | null) => (value === null ? "–" : value.toLocaleString());
  const { overall, polling } = data;
  return (
    <section className="card live-health">
      <div className="live-health-head">
        <h2>
          {t("Live health")}
          <HelpTip text="How much of the live board takes bets, how long markets stay paused after goals and cards, and how many live bets get voided. Use it to compare competitions and tune the live feed." />
        </h2>
        <label className="live-health-days">
          <span className="muted">{t("Period")}</span>
          <select value={days} onChange={(event) => onDays(Number(event.target.value))}>
            <option value={1}>{t("Last 24 hours")}</option>
            <option value={7}>{t("Last 7 days")}</option>
            <option value={30}>{t("Last 30 days")}</option>
          </select>
        </label>
      </div>
      <div className="live-health-stats">
        <div>
          <span className="muted">{t("Board open")}</span>
          <strong>{percent(overall.openOfShown)}</strong>
          <span className="muted">{t("{share} of every market", { share: percent(overall.openOfAll) })}</span>
        </div>
        <div>
          <span className="muted">{t("Pauses after events")}</span>
          <strong>{count(overall.pauses)}</strong>
          <span className="muted">{t("{seconds} on average · {fresh} reopened on fresh prices", { seconds: seconds(overall.averagePauseMs), fresh: overall.freshReopens })}</span>
        </div>
        <div>
          <span className="muted">{t("Live bets voided")}</span>
          <strong>{percent(overall.voidRate)}</strong>
          <span className="muted">{tn(overall.livePicks, "of {count} live pick", "of {count} live picks")}</span>
        </div>
        <div>
          <span className="muted">{t("Feed plan")}</span>
          <strong>{t("{count} a day", { count: count(polling.plan.perDay) })}</strong>
          <span className="muted">{t("{count} a minute · {left} left today", { count: count(polling.plan.perMinute), left: count(polling.plan.leftToday) })}</span>
        </div>
        <div>
          <span className="muted">{t("Live prices read")}</span>
          <strong>{t("Every {seconds}", { seconds: seconds(polling.intervals.boardMs) })}</strong>
          <span className="muted">{t("Busy matches every {seconds}", { seconds: seconds(polling.intervals.priorityMs) })}</span>
        </div>
      </div>
      {data.lag?.broken ? <p className="bm-note">{t("Feed delay figures look wrong, so live betting was not closed. Check the samples below.")}</p> : null}
      {data.lag && data.lag.competitions.length > 0 ? (
        <p className="muted live-health-reasons">
          {data.lag.competitions.map((row) => `${row.competition.replace(/^[^·]+· /, "")}: ${t("{seconds} at the 95th ({goals} goals)", { seconds: seconds(row.p95 * 1000), goals: row.goals })}${row.gated ? ` · ${t("Pre-match only")}` : ""}`).join(" · ")}
          {data.lag.ignored > 0 ? ` · ${t("{count} delay samples ignored", { count: data.lag.ignored })}` : ""}
        </p>
      ) : null}
      {data.pausesByReason.length > 0 ? (
        <p className="muted live-health-reasons">
          {data.pausesByReason.map((row) => t("{reason}: {count}, {seconds} on average", { reason: t(REASON[row.reason] ?? REASON.swing), count: row.pauses, seconds: seconds(row.averageMs) })).join(" · ")}
        </p>
      ) : null}
      {data.competitions.length > 0 ? (
        <details className="live-health-section" open>
          <summary>{tn(data.competitions.length, "By competition ({count})", "By competition ({count})")}</summary>
          <div className="performance-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("Competition")}</th>
                  <th scope="col" className="num">{t("Matches")}</th>
                  <th scope="col" className="num">{t("Board open")}</th>
                  <th scope="col" className="num">{t("Average pause")}</th>
                  <th scope="col" className="num">{t("Voided")}</th>
                  <th scope="col">{t("Limits")}</th>
                </tr>
              </thead>
              <tbody>
                {data.competitions.map((row) => (
                  <tr key={row.competition}>
                    <th scope="row" data-label={t("Competition")}>{row.competition.replace(/^[^·]+· /, "")}</th>
                    <td className="num" data-label={t("Matches")}>{row.matches}</td>
                    <td className="num" data-label={t("Board open")}>{percent(row.openOfShown)}</td>
                    <td className="num" data-label={t("Average pause")}>{seconds(row.averagePauseMs)}</td>
                    <td className="num" data-label={t("Voided")}>{row.livePicks > 0 ? `${percent(row.voidRate)} (${row.livePicks})` : "–"}</td>
                    <td data-label={t("Limits")}>{[row.liveOff ? t("Pre-match only") : null, row.noLiveCards ? t("No live cards") : null, row.noLiveCorners ? t("No live corners") : null].filter(Boolean).join(", ") || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : (
        <p className="muted">{t("Nothing measured yet: the numbers fill in as live matches are played.")}</p>
      )}
      {polling.matches.length > 0 ? (
        <details className="live-health-section">
          <summary>{tn(polling.matches.length, "Live polling by match ({count})", "Live polling by match ({count})")}</summary>
          <div className="performance-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("Match")}</th>
                  <th scope="col" className="num">{t("Read every")}</th>
                  <th scope="col" className="num">{t("Behind the bookmaker")}</th>
                  <th scope="col" className="num">{t("At most")}</th>
                </tr>
              </thead>
              <tbody>
                {polling.matches.map((row) => (
                  <tr key={row.eventId}>
                    <th scope="row" data-label={t("Match")}>{row.name}</th>
                    <td className="num" data-label={t("Read every")}>{seconds(row.everyMs)}</td>
                    <td className="num" data-label={t("Behind the bookmaker")}>{seconds(row.ageMs)}</td>
                    <td className="num" data-label={t("At most")}>{seconds(row.ageMaxMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
      {data.matches.length > 0 ? (
        <details className="live-health-section">
          <summary>{tn(data.matches.length, "By match ({count})", "By match ({count})")}</summary>
          <div className="performance-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t("Match")}</th>
                  <th scope="col" className="num">{t("Board open")}</th>
                  <th scope="col" className="num">{t("Pauses")}</th>
                  <th scope="col" className="num">{t("Average pause")}</th>
                </tr>
              </thead>
              <tbody>
                {data.matches.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" data-label={t("Match")}>
                      {row.name}
                      {row.live ? <span className="live-health-live">{t("Live")}</span> : null}
                    </th>
                    <td className="num" data-label={t("Board open")}>{percent(row.openOfShown)}</td>
                    <td className="num" data-label={t("Pauses")}>{row.pauses}</td>
                    <td className="num" data-label={t("Average pause")}>{seconds(row.averagePauseMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

const REASON: Record<string, string> = {
  goal: msg("Goals"),
  red: msg("Red cards"),
  var: msg("VAR checks and penalties"),
  swing: msg("Price jumps"),
  reopen: msg("Bookmaker reopening"),
  ahead: msg("Goals seen before the prices had them"),
};
