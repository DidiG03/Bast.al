"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BOOK_COVER, bookSymbolImage } from "../../../components/book-symbols";
import { HelpTip } from "../../../components/help-tip";
import { useConfirm } from "../../../components/confirm-dialog";
import { useI18n } from "../../../components/i18n-provider";
import { PageLoading } from "../../../components/loading-spinner";
import { Stat } from "../../../components/commission-views";
import { useToast } from "../../../components/toaster";
import { apiFetch, type CasinoAdmin, type CasinoGame, type CasinoState, type MeResponse } from "../../../lib/api";
import { RED, WHEEL } from "../../../lib/roulette";
import { formatMoney, formatSignedMoney } from "../../../lib/format";
import { msg } from "../../../lib/i18n/core";
import { addDays, startOfMonth, startOfWeek } from "../../../lib/time";

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

/** The new games' tiles: key, page, name and icon. */
const NEW_GAMES: Array<[CasinoGame, string, string, string]> = [
  ["crash", "/dashboard/casino/crash", "Crash", "🚀"],
  ["baccarat", "/dashboard/casino/baccarat", "Baccarat", "🂡"],
  ["hilo", "/dashboard/casino/hilo", "Hi-Lo", "⇅"],
  ["wheel", "/dashboard/casino/wheel", msg("Money Wheel"), "🎡"],
  ["tower", "/dashboard/casino/tower", msg("Tower"), "🗼"],
];

/** Crash, Baccarat, Hi-Lo, Money Wheel and Tower, in the lobby's order. */
const HOUSE_KEYS = ["crash", "baccarat", "hilo", "wheel", "tower"] as const;

/** The games' names on the staff switches; the slots keep their own names. */
const GAME_LABELS: Record<CasinoGame, string> = {
  slot: "Sizzling Hot",
  book: "Book of Ra",
  roulette: msg("Roulette"),
  blackjack: msg("Blackjack"),
  penalty: msg("Penalty"),
  mines: msg("Mines"),
  plinko: "Plinko",
  dice: msg("Dice"),
  keno: msg("Keno"),
  coinflip: msg("Coin Flip"),
  scratch: msg("Scratch Cards"),
  crash: "Crash",
  baccarat: "Baccarat",
  hilo: "Hi-Lo",
  wheel: msg("Money Wheel"),
  tower: msg("Tower"),
};

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
  // Super Admin and the Player's Owner can turn single games off; those tiles don't show.
  // An API older than the website (the minute between their deploys) sends no list: every game shows, as before.
  const games = state.games ?? null;
  const has = (game: CasinoGame) => games === null || games.includes(game);
  const casinoClosed = state.casinoClosed === undefined ? state.closed : state.casinoClosed;
  return (
    <div className="stack">
      <div>
        <h1 style={{ margin: 0 }}>{t("Casino")}</h1>
      </div>
      {casinoClosed || games?.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>{casinoClosed ? ts(casinoClosed) : t("No games are open right now.")}</p>
        </div>
      ) : (
        <div className="casino-lobby">
          {has("slot") ? (
            <Link className="casino-tile is-slot" href="/dashboard/casino/slot">
              <span className="casino-tile-art" aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element -- a small static picture, already sized for the tile */}
                <img className="casino-tile-cover" src="/casino/sizzling-hot.webp" alt="" />
              </span>
              <span className="casino-tile-body">
                <strong>{state.game.name}</strong>
              </span>
            </Link>
          ) : null}
          {has("book") ? (
            <Link className="casino-tile is-book" href="/dashboard/casino/book">
              <span className="casino-tile-art" aria-hidden="true">
                <BookTileArt />
              </span>
              <span className="casino-tile-body">
                <strong>Book of Ra</strong>
              </span>
            </Link>
          ) : null}
          {has("roulette") ? (
            <Link className="casino-tile is-roulette has-cover" href="/dashboard/casino/roulette">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/roulette.webp" fit="cover" position="50% 30%" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Roulette")}</strong>
              </span>
            </Link>
          ) : null}
          {has("blackjack") ? (
            <Link className="casino-tile is-blackjack has-cover" href="/dashboard/casino/blackjack">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/blackjack.webp" fit="cover" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Blackjack")}</strong>
              </span>
            </Link>
          ) : null}
          {has("penalty") ? (
            <Link className="casino-tile is-penalty has-cover" href="/dashboard/casino/penalty">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/penalty.webp" fit="cover" position="50% 30%" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Penalty")}</strong>
              </span>
            </Link>
          ) : null}
          {has("mines") ? (
            <Link className="casino-tile is-mines has-cover" href="/dashboard/casino/mines">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/mines.webp" fit="cover" position="50% 62%" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Mines")}</strong>
              </span>
            </Link>
          ) : null}
          {has("plinko") ? (
            <Link className="casino-tile is-plinko has-cover" href="/dashboard/casino/plinko">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/plinko.webp" fit="cover" />
              </span>
              <span className="casino-tile-body">
                <strong>Plinko</strong>
              </span>
            </Link>
          ) : null}
          {has("dice") ? (
            <Link className="casino-tile is-dice has-cover" href="/dashboard/casino/dice">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/dice.webp" fit="cover" position="50% 55%" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Dice")}</strong>
              </span>
            </Link>
          ) : null}
          {has("keno") ? (
            <Link className="casino-tile is-keno has-cover" href="/dashboard/casino/keno">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/keno.webp" fit="cover" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Keno")}</strong>
              </span>
            </Link>
          ) : null}
          {has("coinflip") ? (
            <Link className="casino-tile is-coin has-cover" href="/dashboard/casino/coin-flip">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/coin-flip.webp" fit="cover" position="50% 70%" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Coin Flip")}</strong>
              </span>
            </Link>
          ) : null}
          {/* Crash, Baccarat, Hi-Lo, Money Wheel and Tower: drawn covers until they have pictures of their own. */}
          {NEW_GAMES.filter(([key]) => has(key)).map(([key, href, name, icon]) => (
            <Link key={key} className={`casino-tile is-${key} has-cover`} href={href}>
              <span className="casino-tile-art" aria-hidden="true">
                <span className={`casino-drawn-cover is-${key}`}>
                  <span className="casino-drawn-icon">{icon}</span>
                  <span className="casino-drawn-name">{key === "wheel" || key === "tower" ? t(name) : name}</span>
                </span>
              </span>
              <span className="casino-tile-body">
                <strong>{key === "wheel" || key === "tower" ? t(name) : name}</strong>
              </span>
            </Link>
          ))}
          {has("scratch") ? (
            <Link className="casino-tile is-scratch has-cover" href="/dashboard/casino/scratch">
              <span className="casino-tile-art" aria-hidden="true">
                <CoverArt src="/casino/scratch.webp" fit="cover" position="50% 30%" />
              </span>
              <span className="casino-tile-body">
                <strong>{t("Scratch Cards")}</strong>
              </span>
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * A game's cover picture filling its tile. A picture shaped unlike the tile (a square logo on a wide tile) is
 * shown whole ("contain") over a blurred copy of itself, so nothing of it is cut off and there are no bare edges.
 */
function CoverArt({ src, fit, position }: { src: string; fit: "cover" | "contain"; position?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- small static pictures, already sized for the tile */}
      {fit === "contain" ? <img className="casino-tile-cover-backdrop" src={src} alt="" /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={`casino-tile-cover${fit === "contain" ? " is-contain" : ""}`} src={src} alt="" style={position ? { objectPosition: position } : undefined} />
    </>
  );
}

/** Book of Ra's tile: the cover picture from its art folder at once (not after the whole folder loads), or the book drawn in code if it's missing. */
function BookTileArt() {
  const [drawn, setDrawn] = useState<string | null>(null);
  // eslint-disable-next-line @next/next/no-img-element -- a picture made in the browser, or one from the art folder
  return drawn ? <img className="casino-tile-cover is-book" src={drawn} alt="" /> : <img className="casino-tile-cover is-book is-photo" src={BOOK_COVER} alt="" onError={() => setDrawn(bookSymbolImage("BOOK", 220))} />;
}

/** A small wheel for the roulette tile. */
const WHEEL_ORDER: readonly number[] = WHEEL;
const pocketFill = (n: number) => (n === 0 ? "#0e8a3e" : RED.has(n) ? "#c4161d" : "#141519");

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
  const [confirm, confirmDialog] = useConfirm();

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
    const team = ownerId ? data?.teams.find((row) => row.ownerId === ownerId)?.username : null;
    const sure = await confirm({
      title: open ? (team ? t("Open the Casino for {name}'s team?", { name: team }) : t("Open the Casino for the whole site?")) : team ? t("Close the Casino for {name}'s team?", { name: team }) : t("Close the Casino for the whole site?"),
      message: open ? t("Players can start new rounds straight away.") : t("Players can't start new rounds. Rounds already started can still be finished."),
      confirmLabel: open ? t("Open the Casino") : t("Close the Casino"),
      danger: !open,
    });
    if (!sure) return;
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

  async function setGame(game: CasinoGame, open: boolean) {
    const sure = await confirm({
      title: open ? t("Turn {game} on?", { game: gameName(game) }) : t("Turn {game} off?", { game: gameName(game) }),
      message: me.role === "SUPER_ADMIN" ? t("This applies to the whole site.") : t("This applies to your team."),
      confirmLabel: open ? t("Turn on") : t("Turn off"),
      danger: !open,
    });
    if (!sure) return;
    setSwitching(game);
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      // Super Admin switches a game for the whole site; an Owner for their own team.
      await apiFetch("/casino/admin/game", token, { method: "POST", body: JSON.stringify({ game, open }) });
      toast.success(open ? t("{game} is on.", { game: gameName(game) }) : t("{game} is off.", { game: gameName(game) }));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("Couldn't change it"));
    } finally {
      setSwitching(null);
    }
  }

  /** What each game is called on the switches. */
  const gameName = (game: CasinoGame) => (game === "slot" ? "Sizzling Hot" : game === "book" ? "Book of Ra" : game === "plinko" ? "Plinko" : t(GAME_LABELS[game]));

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
      {confirmDialog}
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

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Games")}
          <HelpTip
            text={
              isAdmin
                ? "Turn single games on or off for the whole site. A game you turn off is hidden from every team: Owners don't see it and can't turn it back on."
                : "Choose which games your Players see. Rounds already started can still be finished."
            }
          />
        </h2>
        {isAdmin || me.role === "OWNER" ? (
          <div className="casino-game-switches">
            {data.gameList.map((game) => {
              const off = isAdmin ? data.siteGamesOff.includes(game) : (data.teams[0]?.gamesOff ?? []).includes(game);
              return (
                <label className="casino-switch" key={game}>
                  <input type="checkbox" checked={!off} disabled={switching !== null} onChange={(event) => setGame(game, event.target.checked)} />
                  <span>
                    <strong>{gameName(game)}</strong>
                    <span className="muted">{isAdmin ? (off ? t("Off: hidden from every team.") : t("On for the whole site.")) : off ? t("Hidden from your Players.") : t("Your Players see it.")}</span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <p style={{ margin: 0 }}>
            {(() => {
              const open = data.gameList.filter((game) => !(data.teamGamesOff ?? []).includes(game));
              return open.length > 0 ? t("Open for your team: {games}.", { games: open.map(gameName).join(", ") }) : t("Your Owner hasn't opened any games for your team.");
            })()}
          </p>
        )}
      </section>

      {/* Just the period switch: a card around it only added empty space. */}
      <nav className="tabs-nav commission-range" aria-label={t("Period")}>
        {RANGES.map(([value, label]) => (
          <button type="button" key={value} className={`tab-button${range === value ? " is-active" : ""}`} aria-pressed={range === value} onClick={() => setRange(value)}>
            {t(label)}
          </button>
        ))}
      </nav>

      <div className="report-grid">
        <Stat label={t("Spins and rounds")} value={String(data.totals.spins + data.games.roulette.spins + data.games.blackjack.spins + data.games.book.spins + data.games.mines.spins + data.games.penalty.spins + data.games.plinko.spins + data.games.dice.spins + data.games.keno.spins + data.games.coinflip.spins + data.games.scratch.spins + HOUSE_KEYS.reduce((sum, key) => sum + (data.games[key]?.spins ?? 0), 0))} hint={tn(players.length, "{count} Player", "{count} Players")} />
        <Stat label={t("Staked")} value={formatMoney(data.totals.staked)} hint={t("What spins and rounds cost")} />
        <Stat label={t("Paid out")} value={formatMoney(data.totals.won)} hint={data.totals.payoutRate === null ? t("No spins yet") : t("{rate}% of what was staked", { rate: data.totals.payoutRate })} />
        <Stat label={t("Casino profit")} help="What Players lost in the Casino minus what they won. It's part of the team's profit in Commissions." value={formatSignedMoney(data.totals.net)} highlight={data.totals.net < 0 ? "bad" : "good"} />
      </div>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>{t("Each game")}</h2>
        <div className="report-list">
          {(
            [
              ["slot", "Sizzling Hot", `${tn(data.games.slot.spins, "{count} spin", "{count} spins")}${data.games.slot.freeSpins ? ` · ${tn(data.games.slot.freeSpins, "{count} free spin", "{count} free spins")}` : ""}`],
              ["roulette", t("Roulette"), tn(data.games.roulette.spins, "{count} round", "{count} rounds")],
              ["blackjack", t("Blackjack"), tn(data.games.blackjack.spins, "{count} hand", "{count} hands")],
              ["book", "Book of Ra", `${tn(data.games.book.spins, "{count} spin", "{count} spins")} · ${tn(data.games.book.freeSpins, "{count} free spin", "{count} free spins")}`],
              ["mines", t("Mines"), tn(data.games.mines.spins, "{count} round", "{count} rounds")],
              ["penalty", t("Penalty"), tn(data.games.penalty.spins, "{count} round", "{count} rounds")],
              ["plinko", "Plinko", tn(data.games.plinko.spins, "{count} ball", "{count} balls")],
              ["dice", t("Dice"), tn(data.games.dice.spins, "{count} roll", "{count} rolls")],
              ["keno", t("Keno"), tn(data.games.keno.spins, "{count} round", "{count} rounds")],
              ["coinflip", t("Coin Flip"), tn(data.games.coinflip.spins, "{count} flip", "{count} flips")],
              ["scratch", t("Scratch Cards"), tn(data.games.scratch.spins, "{count} card", "{count} cards")],
              ["crash", "Crash", tn(data.games.crash?.spins ?? 0, "{count} round", "{count} rounds")],
              ["baccarat", "Baccarat", tn(data.games.baccarat?.spins ?? 0, "{count} hand", "{count} hands")],
              ["hilo", "Hi-Lo", tn(data.games.hilo?.spins ?? 0, "{count} round", "{count} rounds")],
              ["wheel", t("Money Wheel"), tn(data.games.wheel?.spins ?? 0, "{count} spin", "{count} spins")],
              ["tower", t("Tower"), tn(data.games.tower?.spins ?? 0, "{count} climb", "{count} climbs")],
            ] as const
          ).map(([key, name, count]) => {
            const game = data.games[key] ?? { spins: 0, staked: 0, won: 0, payoutRate: null };
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
                    {player.blackjack.hands > 0 ? ` · ${tn(player.blackjack.hands, "{count} blackjack hand", "{count} blackjack hands")}` : ""}
                    {player.book.spins > 0 ? ` · ${tn(player.book.spins, "{count} Book of Ra spin", "{count} Book of Ra spins")}` : ""}
                    {player.mines.rounds > 0 ? ` · ${tn(player.mines.rounds, "{count} Mines round", "{count} Mines rounds")}` : ""}
                    {player.penalty.rounds > 0 ? ` · ${tn(player.penalty.rounds, "{count} Penalty round", "{count} Penalty rounds")}` : ""}
                    {player.plinko.balls > 0 ? ` · ${tn(player.plinko.balls, "{count} Plinko ball", "{count} Plinko balls")}` : ""}
                    {player.dice.rolls > 0 ? ` · ${tn(player.dice.rolls, "{count} dice roll", "{count} dice rolls")}` : ""}
                    {player.keno.rounds > 0 ? ` · ${tn(player.keno.rounds, "{count} Keno round", "{count} Keno rounds")}` : ""}
                    {player.coinFlip.flips > 0 ? ` · ${tn(player.coinFlip.flips, "{count} coin flip", "{count} coin flips")}` : ""}
                    {player.scratch.cards > 0 ? ` · ${tn(player.scratch.cards, "{count} scratch card", "{count} scratch cards")}` : ""}
                    {HOUSE_KEYS.map((key) => (player.house?.[key].rounds ? ` · ${t(GAME_LABELS[key])}: ${player.house[key].rounds}` : "")).join("")} · {t("{amount} staked", { amount: formatMoney(player.staked) })} · {t("{amount} paid out", { amount: formatMoney(player.won) })}
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
