"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { OddsEvent, OddsSelection, Sport } from "../lib/api";
import { liveClock } from "../lib/live";
import { pickLabel } from "../lib/picks";
import { MAX_SLIP, addToSlip, readSlip } from "../lib/slip";
import { dayKey, isDaysFromToday } from "../lib/time";
import { useI18n } from "./i18n-provider";
import { SportIcon } from "./sport-icon";
import { TeamCrest } from "./team-crest";
import { useToast } from "./toaster";

const MATCH_TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

function dayLabel(iso: string, t: (text: string) => string): string {
  if (isDaysFromToday(iso, 0)) return t("Today");
  if (isDaysFromToday(iso, 1)) return t("Tomorrow");
  const [year, month, day] = dayKey(iso).split("-");
  return `${day}/${month}/${year}`;
}

function shortPick(selection: OddsSelection, i18n: { t: (text: string, vars?: Record<string, string | number>) => string; ts: (text: string | null | undefined) => string }): string {
  if (selection.key === "home") return "1";
  if (selection.key === "draw") return "X";
  if (selection.key === "away") return "2";
  return pickLabel(selection.name, i18n);
}

/** A home match: the teams open the board, and the main prices go straight onto the slip. */
export function HomeEventCard({ event, sport, showSport }: { event: OddsEvent; sport: Sport; showSport: boolean }) {
  const { t, ts, date } = useI18n();
  const { userId } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const href = `/dashboard/bet?${sport === "football" ? "" : `sport=${sport}&`}match=${encodeURIComponent(event.id)}`;
  const playing = event.status === "LIVE";
  const scored = event.homeScore !== null && event.awayScore !== null && (playing || event.status === "COMPLETED");
  const market = event.markets[0];
  const selections = market && market.selections.length > 0 && market.selections.length <= 3 ? market.selections : [];

  useEffect(() => {
    if (!userId) return;
    setPicked(new Set(readSlip(userId).map((item) => item.selectionId)));
  }, [userId]);

  function choose(selection: OddsSelection) {
    if (!market) return;
    if (!userId) {
      router.push(href);
      return;
    }
    const result = addToSlip(userId, {
      selectionId: selection.id,
      eventId: event.id,
      eventName: event.name,
      startsAt: event.startsAt,
      market: market.name,
      name: selection.name,
      odds: selection.price,
      live: event.live ?? playing,
      sp: selection.sp,
    });
    if (result === "full") {
      toast.error(t("A slip holds up to {max} bets.", { max: MAX_SLIP }));
      return;
    }
    setPicked((current) => new Set(current).add(selection.id));
    router.push(href);
  }

  return (
    <article className="player-top-event">
      <Link href={href} className="player-top-event-body">
        <div className="player-top-event-head">
          {event.leagueLogo ? <img className="league-crest" src={event.leagueLogo} alt="" /> : null}
          {event.countryFlag ? <img className="country-flag" src={event.countryFlag} alt={event.country ?? ""} /> : null}
          <span className="player-top-event-league">
            {showSport ? <SportIcon sport={sport} /> : null}
            {event.league}
          </span>
        </div>
        <div className="player-top-event-main">
          <div className={`player-top-when${playing ? " is-live" : ""}`}>
            {playing ? <span className="live-dot" aria-hidden="true" /> : null}
            {playing ? (
              <span>{liveClock(event, t)}</span>
            ) : (
              <time dateTime={event.startsAt}>
                {dayLabel(event.startsAt, t)}
                <span>{date(event.startsAt, MATCH_TIME)}</span>
              </time>
            )}
          </div>
          <div className="player-top-sides">
            <span className="player-top-side">
              <TeamCrest name={event.homeTeam ?? event.name} logo={event.homeLogo} />
              <span>{event.homeTeam ?? event.name}</span>
              {scored ? <strong className="player-top-score">{event.homeScore}</strong> : null}
            </span>
            {event.awayTeam ? (
              <span className="player-top-side">
                <TeamCrest name={event.awayTeam} logo={event.awayLogo} />
                <span>{event.awayTeam}</span>
                {scored ? <strong className="player-top-score">{event.awayScore}</strong> : null}
              </span>
            ) : null}
          </div>
        </div>
      </Link>
      {selections.length > 0 ? (
        <div className={`player-top-prices has-${selections.length}`}>
          {selections.map((selection) => {
            const off = !event.bettable || Boolean(market?.suspended || selection.suspended) || selection.price <= 1;
            const label = shortPick(selection, { t, ts });
            return (
              <button
                key={selection.id}
                type="button"
                className={`player-top-pick${picked.has(selection.id) ? " is-selected" : ""}`}
                disabled={off}
                onClick={() => choose(selection)}
                aria-label={t(off ? "{pick} at {odds}, {market}, {match}, suspended" : "{pick} at {odds}, {market}, {match}", {
                  pick: label,
                  odds: selection.price.toFixed(2),
                  market: ts(market?.name),
                  match: event.name,
                })}
              >
                <span className="odds-selection-name">{label}</span>
                <span>{off && selection.price <= 1 ? "–" : selection.price.toFixed(2)}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
