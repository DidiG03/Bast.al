"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HelpTip } from "../../../components/help-tip";
import { useI18n } from "../../../components/i18n-provider";
import { PageLoading } from "../../../components/loading-spinner";
import { symbolImage } from "../../../components/slot-symbols";
import { Stat } from "../../../components/commission-views";
import { useToast } from "../../../components/toaster";
import { apiFetch, type CasinoAdmin, type CasinoState, type MeResponse } from "../../../lib/api";
import { formatMoney, formatSignedMoney } from "../../../lib/format";
import { msg } from "../../../lib/i18n/core";
import { addDays, startOfMonth, startOfWeek } from "../../../lib/time";

/** Roulette's payout rate, for its tile: 36/37 (the API's rules say the same). */
const ROULETTE_RATE = 97.3;
/** Blackjack's, with perfect play, as measured by the API's scripts/blackjack-rtp.mjs. */
const BLACKJACK_RATE = 99.6;

/** The Casino: a lobby of games for Players; the switches and the figures for staff. */
export default function CasinoPage() {
  const { getToken } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      setMe(await apiFetch<MeResponse>("/users/me", token));
    })().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <PageLoading label="Loading the Casino" />;
  return me.role === "PLAYER" ? <CasinoLobby /> : <CasinoOverview me={me} />;
}

/** The Player's lobby: one tile per game. */
function CasinoLobby() {
  const { getToken } = useAuth();
  const { t, ts } = useI18n();
  const toast = useToast();
  const [state, setState] = useState<CasinoState | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      setState(await apiFetch<CasinoState>("/casino", token));
    })().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return <PageLoading label="Loading the Casino" />;
  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: 0 }}>{t("Casino")}</h1>
        <p className="muted report-subtitle">{t("Pick a game. Every game plays with your balance, {amount} right now.", { amount: formatMoney(state.balance) })}</p>
      </div>
      {state.closed ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <div className="casino-lobby">
          <Link className="casino-tile is-slot" href="/dashboard/casino/slot">
            <span className="casino-tile-art" aria-hidden="true">
              {(["SEVEN", "CHERRY", "MELON"] as const).map((symbol) => (
                // Drawn in the browser, so there's nothing for next/image to optimise.
                // eslint-disable-next-line @next/next/no-img-element
                <img key={symbol} src={symbolImage(symbol)} alt="" />
              ))}
            </span>
            <span className="casino-tile-body">
              <strong>{state.game.name}</strong>
              <span>{t("Fruit slot: 5 reels, 5 lines, double or nothing.")}</span>
              <small>{t("Pays back {rate}% on average", { rate: state.game.payoutRate })}</small>
            </span>
          </Link>
          <Link className="casino-tile is-roulette" href="/dashboard/casino/roulette">
            <span className="casino-tile-art" aria-hidden="true">
              <RouletteTileArt />
            </span>
            <span className="casino-tile-body">
              <strong>{t("Roulette")}</strong>
              <span>{t("European roulette with a single 0. Bet on numbers, colours and more.")}</span>
              <small>{t("Pays back {rate}% on average", { rate: ROULETTE_RATE })}</small>
            </span>
          </Link>
          <Link className="casino-tile is-blackjack" href="/dashboard/casino/blackjack">
            <span className="casino-tile-art" aria-hidden="true">
              <span className="casino-tile-card">
                A<br />♠
              </span>
              <span className="casino-tile-card is-red">
                K<br />♥
              </span>
            </span>
            <span className="casino-tile-body">
              <strong>{t("Blackjack")}</strong>
              <span>{t("Beat the dealer to 21. Blackjack pays 3 to 2.")}</span>
              <small>{t("Pays back about {rate}% played perfectly", { rate: BLACKJACK_RATE })}</small>
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

/** A small wheel for the roulette tile. */
function RouletteTileArt() {
  const pockets = 37;
  const point = (angle: number, radius: number) => `${(Math.cos(angle) * radius).toFixed(2)} ${(Math.sin(angle) * radius).toFixed(2)}`;
  return (
    <svg viewBox="-50 -50 100 100" className="casino-tile-wheel">
      <circle r="49" fill="#5c2b10" />
      <circle r="44" fill="#2a1206" />
      {Array.from({ length: pockets }, (_, index) => {
        const from = (index / pockets) * Math.PI * 2;
        const to = ((index + 1) / pockets) * Math.PI * 2;
        const fill = index === 0 ? "#0d8a3a" : index % 2 ? "#c3161c" : "#16171b";
        return <path key={index} d={`M${point(from, 40)} A40 40 0 0 1 ${point(to, 40)} L${point(to, 26)} A26 26 0 0 0 ${point(from, 26)} Z`} fill={fill} stroke="#e2b552" strokeWidth="0.5" />;
      })}
      <circle r="25" fill="#7d3e18" stroke="#e2b552" strokeWidth="1" />
      <circle r="6" fill="#e2b552" />
      <circle cx="18" cy="-29" r="3.4" fill="#f4f4f6" />
    </svg>
  );
}

type Range = "this-week" | "last-week" | "this-month";
const RANGES: Array<[Range, string]> = [
  ["this-week", msg("This week")],
  ["last-week", msg("Last week")],
  ["this-month", msg("This month")],
];

function rangeDates(range: Range): { from: Date; to: Date } {
  const now = new Date();
  if (range === "last-week") {
    const to = startOfWeek(now);
    return { from: addDays(to, -7), to };
  }
  return { from: range === "this-month" ? startOfMonth(now) : startOfWeek(now), to: now };
}

/** Super Admin, Owners and Managers: the switches, and how the Casino is doing per Player. */
function CasinoOverview({ me }: { me: MeResponse }) {
  const { getToken } = useAuth();
  const { t, tn } = useI18n();
  const toast = useToast();
  const [range, setRange] = useState<Range>("this-week");
  const [data, setData] = useState<CasinoAdmin | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const { from, to } = rangeDates(range);
    setData(await apiFetch<CasinoAdmin>(`/casino/admin?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`, token));
  }, [getToken, range, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // Reload when the period changes, not when the sign-in helpers do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  async function setOpen(open: boolean, ownerId?: string) {
    setSwitching(ownerId ?? "site");
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      await apiFetch("/casino/admin/open", token, { method: "POST", body: JSON.stringify({ open, ...(ownerId ? { ownerId } : {}) }) });
      toast.success(open ? t("The Casino is open.") : t("The Casino is closed."));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't change it"));
    } finally {
      setSwitching(null);
    }
  }

  const players = useMemo(() => data?.players ?? [], [data]);
  if (!data) return <PageLoading label="Loading the Casino" />;
  const isAdmin = me.role === "SUPER_ADMIN";
  const subtitle = isAdmin
    ? t("Open the Casino for the site and for each Owner's team, and see how it's doing.")
    : me.role === "OWNER"
      ? t("Open the Casino for your team, and see how your Players are doing on it.")
      : t("How your Players are doing in the Casino.");

  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: 0 }}>{t("Casino")}</h1>
        <p className="muted report-subtitle">{subtitle}</p>
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Open or closed")}
          <HelpTip text="Players see the Casino only when it's open for the whole site and for their team. Spins use the Player's balance, and their profit counts in Commissions like bets do." />
        </h2>
        {isAdmin || me.role === "OWNER" ? (
          <label className="casino-switch">
            <input type="checkbox" checked={data.siteOpen} disabled={!isAdmin || switching !== null} onChange={(event) => setOpen(event.target.checked)} />
            <span>
              <strong>{t("The whole site")}</strong>
              <span className="muted">{isAdmin ? t("Super Admin's switch. Off closes it for every team.") : data.siteOpen ? t("Super Admin has it open.") : t("Super Admin has it closed for now, so your Players don't see it yet.")}</span>
            </span>
          </label>
        ) : null}
        {data.teams.map((team) => (
          <label className="casino-switch" key={team.ownerId}>
            <input type="checkbox" checked={team.open} disabled={switching !== null} onChange={(event) => setOpen(event.target.checked, team.ownerId)} />
            <span>
              <strong>{me.role === "OWNER" ? t("Your team") : t("{name}'s team", { name: team.username })}</strong>
              <span className="muted">{team.open ? (data.siteOpen ? t("Open: Players can play.") : t("Open, but the site is closed.")) : t("Closed.")}</span>
            </span>
          </label>
        ))}
        {me.role === "MANAGER" ? (
          <p style={{ margin: 0 }}>{data.siteOpen && data.teamOpen ? t("Open: your Players can play.") : t("Closed. Your Owner decides whether it's open for your team.")}</p>
        ) : null}
      </section>

      <div className="card stack commission-period">
        <nav className="tabs-nav commission-range" aria-label={t("Period")}>
          {RANGES.map(([value, label]) => (
            <button type="button" key={value} className={`tab-button${range === value ? " is-active" : ""}`} aria-pressed={range === value} onClick={() => setRange(value)}>
              {t(label)}
            </button>
          ))}
        </nav>
      </div>

      <div className="report-grid">
        <Stat label={t("Spins and rounds")} value={String(data.totals.spins + data.games.roulette.spins + data.games.blackjack.spins)} hint={tn(players.length, "{count} Player", "{count} Players")} />
        <Stat label={t("Staked")} value={formatMoney(data.totals.staked)} hint={t("What spins and rounds cost")} />
        <Stat label={t("Paid out")} value={formatMoney(data.totals.won)} hint={data.totals.payoutRate === null ? t("No spins yet") : t("{rate}% of what was staked", { rate: data.totals.payoutRate })} />
        <Stat label={t("Casino profit")} help="What Players lost in the Casino minus what they won. It's part of the team's profit in Commissions." value={formatSignedMoney(data.totals.net)} highlight={data.totals.net < 0 ? "bad" : "good"} />
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Each game")}</h2>
        <div className="report-list">
          {(
            [
              ["slot", t("Fruit slot"), tn(data.games.slot.spins, "{count} spin", "{count} spins")],
              ["roulette", t("Roulette"), tn(data.games.roulette.spins, "{count} round", "{count} rounds")],
              ["blackjack", t("Blackjack"), tn(data.games.blackjack.spins, "{count} hand", "{count} hands")],
            ] as const
          ).map(([key, name, count]) => {
            const game = data.games[key];
            const profit = Math.round((game.staked - game.won) * 100) / 100;
            return (
              <div className="report-list-row" key={key}>
                <div>
                  <strong>{name}</strong>
                  <span className="muted">
                    {count} · {t("{amount} staked", { amount: formatMoney(game.staked) })} · {t("{amount} paid out", { amount: formatMoney(game.won) })}
                    {game.payoutRate === null ? "" : ` · ${t("{rate}% paid back", { rate: game.payoutRate })}`}
                  </span>
                </div>
                <strong className={profit < 0 ? "is-bad" : undefined}>{formatSignedMoney(profit)}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Players")}</h2>
        {players.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No spins in this period.")}</p>
        ) : (
          <div className="report-list">
            {players.map((player) => (
              <div className="report-list-row" key={player.id}>
                <div>
                  <strong>{player.username}</strong>
                  <span className="muted">
                    {tn(player.spins, "{count} spin", "{count} spins")}
                    {player.roulette.spins > 0 ? ` · ${tn(player.roulette.spins, "{count} roulette round", "{count} roulette rounds")}` : ""}
                    {player.blackjack.hands > 0 ? ` · ${tn(player.blackjack.hands, "{count} blackjack hand", "{count} blackjack hands")}` : ""} · {t("{amount} staked", { amount: formatMoney(player.staked) })} · {t("{amount} paid out", { amount: formatMoney(player.won) })}
                  </span>
                </div>
                <strong className={player.net < 0 ? "is-bad" : undefined}>{formatSignedMoney(player.net)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
