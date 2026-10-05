"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { HelpTip } from "../../../components/help-tip";
import { useI18n } from "../../../components/i18n-provider";
import { PageLoading } from "../../../components/loading-spinner";
import { Stat } from "../../../components/commission-views";
import { useToast } from "../../../components/toaster";
import { apiFetch, type CasinoAdmin, type CasinoState, type MeResponse } from "../../../lib/api";
import { RED, WHEEL } from "../../../lib/roulette";
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
              {/* eslint-disable-next-line @next/next/no-img-element -- a small static picture, already sized for the tile */}
              <img className="casino-tile-cover" src="/casino/sizzling-hot.webp" alt="" />
            </span>
            <span className="casino-tile-body">
              <strong>{state.game.name}</strong>
              <span>{t("Hot fruits and blazing sevens! The classic fruit slot with 5 reels and 5 lines, where the star pays anywhere on the screen.")}</span>
              <small>{t("Pays back {rate}% on average", { rate: state.game.payoutRate })}</small>
            </span>
          </Link>
          <Link className="casino-tile is-roulette" href="/dashboard/casino/roulette">
            <span className="casino-tile-art" aria-hidden="true">
              <RouletteTileArt />
            </span>
            <span className="casino-tile-body">
              <strong>{t("Roulette")}</strong>
              <span>{t("The classic European roulette with a single zero. Place your chips, spin the wheel and watch where the ball lands.")}</span>
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
              <span>{t("Get as close to 21 as you can without going over, and beat the dealer's hand. Blackjack pays 3 to 2.")}</span>
              <small>{t("Pays back about {rate}% played perfectly", { rate: BLACKJACK_RATE })}</small>
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}

/** A small wheel for the roulette tile. */
const WHEEL_ORDER: readonly number[] = WHEEL;
const pocketFill = (n: number) => (n === 0 ? "#0e8a3e" : RED.has(n) ? "#c4161d" : "#141519");

/**
 * The roulette tile: a European wheel on the tile's green felt (numbers in wheel order,
 * a wooden rim, the gold turret, a ball resting in a pocket) beside a strip of
 * the betting layout with a few chips on it. The wheel turns on hover.
 */
function RouletteTileArt() {
  const cx = 84;
  const cy = 75;
  const step = 360 / WHEEL_ORDER.length;
  const at = (deg: number, r: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const arc = (from: number, to: number, outer: number, inner: number) => {
    const [x1, y1] = at(from, outer);
    const [x2, y2] = at(to, outer);
    const [x3, y3] = at(to, inner);
    const [x4, y4] = at(from, inner);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${outer} ${outer} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}L${x3.toFixed(2)} ${y3.toFixed(2)}A${inner} ${inner} 0 0 0 ${x4.toFixed(2)} ${y4.toFixed(2)}Z`;
  };
  // The ball sits in 17's pocket.
  const ballAngle = WHEEL_ORDER.indexOf(17) * step + step / 2;
  const [bx, by] = at(ballAngle, 38.5);
  // A strip of the layout: 0, then 1–18 in three rows, the top row 3, 6, 9 …
  const lx = 184;
  const ly = 24;
  const cw = 19;
  const ch = 26;
  const chip = (x: number, y: number, color: string, layers: number) => (
    <g>
      {Array.from({ length: layers }, (_, i) => (
        <g key={i} transform={`translate(${x} ${y - i * 2.6})`}>
          <ellipse rx="8.5" ry="4" cy="1.6" fill="rgba(0,0,0,0.35)" />
          <ellipse rx="8.5" ry="4" fill={color} stroke="rgba(0,0,0,0.35)" strokeWidth="0.4" />
          <ellipse rx="8.5" ry="4" fill="none" stroke="#fff" strokeWidth="1.6" strokeDasharray="2.2 3.1" />
          <ellipse rx="5" ry="2.3" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="0.5" />
        </g>
      ))}
    </g>
  );
  return (
    <svg viewBox="8 0 304 150" className="roulette-tile-scene">
      <defs>
        <radialGradient id="rt-wood" cx="50%" cy="40%" r="60%">
          <stop offset="0.82" stopColor="#7a3a14" />
          <stop offset="0.93" stopColor="#4a1f08" />
          <stop offset="1" stopColor="#2a1003" />
        </radialGradient>
        <radialGradient id="rt-cone" cx="45%" cy="38%" r="65%">
          <stop offset="0" stopColor="#c27a3c" />
          <stop offset="0.6" stopColor="#7e3d16" />
          <stop offset="1" stopColor="#4b2109" />
        </radialGradient>
        <linearGradient id="rt-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff1b8" />
          <stop offset="0.45" stopColor="#e2b552" />
          <stop offset="1" stopColor="#8a6018" />
        </linearGradient>
        <radialGradient id="rt-ball" cx="35%" cy="30%" r="70%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#e6e6ea" />
          <stop offset="1" stopColor="#9a9aa2" />
        </radialGradient>
        <radialGradient id="rt-track" cx="50%" cy="50%" r="50%">
          <stop offset="0.86" stopColor="#1c0d05" />
          <stop offset="1" stopColor="#5b2b0f" />
        </radialGradient>
      </defs>
      {/* The betting layout, tilted a little as seen from the player's seat. */}
      <g transform={`translate(0 0) skewX(-6)`} opacity="0.95">
        <rect x={lx - 18} y={ly} width="18" height={ch * 3} rx="9" fill={pocketFill(0)} stroke="rgba(255,255,255,0.75)" strokeWidth="0.8" />
        <text x={lx - 9} y={ly + ch * 1.5 + 3.5} textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff">0</text>
        {Array.from({ length: 18 }, (_, i) => {
          const n = i + 1;
          const col = Math.floor(i / 3);
          const row = 2 - (i % 3);
          const x = lx + col * cw;
          const y = ly + row * ch;
          return (
            <g key={n}>
              <rect x={x} y={y} width={cw} height={ch} fill="rgba(0,0,0,0.08)" stroke="rgba(255,255,255,0.75)" strokeWidth="0.8" />
              <ellipse cx={x + cw / 2} cy={y + ch / 2} rx="7" ry="9" fill={pocketFill(n)} />
              <text x={x + cw / 2} y={y + ch / 2 + 3.3} textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">
                {n}
              </text>
            </g>
          );
        })}
        <rect x={lx} y={ly + ch * 3} width={cw * 4} height="17" fill="rgba(0,0,0,0.08)" stroke="rgba(255,255,255,0.75)" strokeWidth="0.8" />
        <text x={lx + cw * 2} y={ly + ch * 3 + 12} textAnchor="middle" fontSize="8.5" fontWeight="800" fill="#f4e3ad" letterSpacing="0.8">1ST 12</text>
        <rect x={lx + cw * 4} y={ly + ch * 3} width={cw * 2} height="17" fill="rgba(0,0,0,0.08)" stroke="rgba(255,255,255,0.75)" strokeWidth="0.8" />
        <path d={`M${lx + cw * 5 - 6} ${ly + ch * 3 + 8.5}l6 -5l6 5l-6 5z`} fill={pocketFill(1)} />
      </g>
      {/* Chips sit on the lines, as corner and split bets do; the layout leans 6°, so they shift left the lower they are. */}
      {chip(lx + cw * 4 - (ly + ch * 2) * 0.105, ly + ch * 2 + 2, "#1f6fe0", 3)}
      {chip(lx + cw * 3 - (ly + ch * 0.5) * 0.105, ly + ch * 0.5 + 2, "#e63a36", 2)}
      {chip(lx + cw * 6 - (ly + ch * 3 + 8) * 0.105 + 4, ly + ch * 3 + 12, "#f2c230", 4)}
      {/* The wheel */}
      <ellipse cx={cx + 4} cy={cy + 8} rx="66" ry="62" fill="rgba(0,0,0,0.4)" />
      <circle cx={cx} cy={cy} r="67" fill="url(#rt-wood)" />
      <circle cx={cx} cy={cy} r="58.5" fill="url(#rt-track)" stroke="url(#rt-gold)" strokeWidth="1" />
      <g className="roulette-tile-rotor">
        {WHEEL_ORDER.map((n, i) => {
          const from = i * step;
          const to = from + step;
          const [tx, ty] = at(from + step / 2, 47.5);
          return (
            <g key={n}>
              <path d={arc(from, to, 52.5, 42.5)} fill={pocketFill(n)} stroke="#d9ab4a" strokeWidth="0.45" />
              <path d={arc(from, to, 42.5, 34)} fill={n === 0 ? "#0a6b30" : RED.has(n) ? "#8f1015" : "#0c0d10"} stroke="#d9ab4a" strokeWidth="0.45" />
              <text x={tx} y={ty} fontSize="5.4" fontWeight="800" fill="#fff" textAnchor="middle" dominantBaseline="central" transform={`rotate(${from + step / 2} ${tx} ${ty})`}>
                {n}
              </text>
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r="34" fill="url(#rt-cone)" stroke="url(#rt-gold)" strokeWidth="1.2" />
        <circle cx={cx} cy={cy} r="24" fill="none" stroke="rgba(255,220,160,0.25)" strokeWidth="0.8" />
        {[0, 90, 180, 270].map((deg) => {
          const [ex, ey] = at(deg, 20);
          return (
            <g key={deg}>
              <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="url(#rt-gold)" strokeWidth="3" strokeLinecap="round" />
              <circle cx={ex} cy={ey} r="3" fill="url(#rt-gold)" />
            </g>
          );
        })}
        <circle cx={cx} cy={cy} r="7.5" fill="url(#rt-gold)" stroke="#7a5212" strokeWidth="0.6" />
        <circle cx={cx - 2} cy={cy - 2.5} r="2.4" fill="rgba(255,255,255,0.7)" />
      </g>
      <circle cx={bx + 0.8} cy={by + 1.2} r="3.6" fill="rgba(0,0,0,0.45)" />
      <circle cx={bx} cy={by} r="3.6" fill="url(#rt-ball)" />
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
