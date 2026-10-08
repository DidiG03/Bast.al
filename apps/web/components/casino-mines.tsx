"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { useGameKeys } from "./use-game-keys";
import { apiFetch, type MinesRoundView, type MinesState, type MinesStepResult, type MinesTile } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useIdempotencyKey } from "../lib/use-idempotency-key";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** Coins that fly off a safe tile, as offsets from its centre. */
const COIN_BURST = [
  ["-28px", "-36px"],
  ["32px", "-22px"],
  ["-30px", "18px"],
  ["26px", "24px"],
  ["2px", "-42px"],
] as const;

/** Debris from the mine you hit. */
const BLAST_SHARDS = [
  ["-30px", "-32px"],
  ["28px", "-24px"],
  ["-24px", "26px"],
  ["26px", "28px"],
  ["0px", "-36px"],
  ["34px", "2px"],
  ["-36px", "2px"],
  ["6px", "34px"],
] as const;

/** Tiles that were covered on the round in play and are now showing. A new round doesn't count. */
function justOpened(previous: MinesRoundView | null, next: MinesRoundView): number[] {
  if (!previous || previous.phase !== "PLAY") return [];
  const opened: number[] = [];
  next.tiles.forEach((tile, index) => {
    if (previous.tiles[index] === "hidden" && tile !== "hidden") opened.push(index);
  });
  return opened;
}

/** Mines for a Player: pick the mines and the stake, open tiles, cash out before one blows. */
export function MinesGame() {
  const { getToken } = useAuth();
  const { t, ts, tn, date } = useI18n();
  const toast = useToast();
  const startKey = useIdempotencyKey();
  const stepKey = useIdempotencyKey();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<MinesState | null>(null);
  const [balance, setBalance] = useState(0);
  const [mines, setMines] = useState(3);
  const [bet, setBet] = useState(0);
  const [round, setRound] = useState<MinesRoundView | null>(null);
  const [recent, setRecent] = useState<MinesState["recent"]>([]);
  const [busy, setBusy] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [boom, setBoom] = useState(false);
  const boomTimer = useRef<number | null>(null);
  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => () => {
    if (boomTimer.current) window.clearTimeout(boomTimer.current);
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<MinesState>("/casino/mines", token);
    setState(next);
    setBalance(next.balance);
    setRecent(next.recent);
    setRound(next.round ?? next.recent[0] ?? null);
    setMines((current) => (next.game.mineCounts.includes(current) ? current : next.game.mineCounts[1] ?? next.game.mineCounts[0]));
    setBet((current) => current || Math.min(next.game.bets[1] ?? next.game.bets[0], next.tableMax));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy) setBalance(event.balance);
  });

  const playing = round?.phase === "PLAY";
  const board = round?.tiles ?? Array.from({ length: state?.game.tiles ?? 25 }, () => "hidden" as MinesTile);

  async function send(path: string, body: object | null, key: ReturnType<typeof useIdempotencyKey>) {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const text = body ? JSON.stringify(body) : "";
    const result = await apiFetch<MinesStepResult>(path, token, { method: "POST", ...(text ? { body: text } : {}), idempotencyKey: key.keyFor(path, text) });
    key.done();
    return result;
  }

  function show(next: MinesRoundView, balanceNext: number) {
    const opened = justOpened(round, next);
    // A mine ends the round and flips the whole field. Only the one you hit blows up;
    // the rest just show, so the blast stays the thing you see.
    const burst = next.phase === "LOST" ? opened.filter((index) => next.tiles[index] === "hit") : opened;
    setFresh(new Set(burst));
    setRound(next);
    setBalance(balanceNext);
    // The tap already woke the audio. Wake it again in case the browser slept it while the server answered.
    slotSound.unlock();
    if (next.phase === "LOST") {
      setBoom(true);
      if (boomTimer.current) window.clearTimeout(boomTimer.current);
      boomTimer.current = window.setTimeout(() => setBoom(false), 700);
      slotSound.explosion();
    } else {
      setBoom(false);
      if (next.phase === "WON") {
        slotSound.win(next.capped || next.multiplier >= 10);
        slotSound.coins(Math.min(1400, 400 + next.cashout * 20));
      } else if (opened.length > 0) slotSound.coinPop(next.opened);
      else if (next.opened === 0) slotSound.click();
    }
    if (next.phase !== "PLAY") {
      setRecent((rows) => [{ ...next, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...rows].slice(0, 10));
    }
  }

  async function start() {
    if (!state || playing || busy) return;
    slotSound.unlock();
    setBusy(true);
    try {
      const result = await send("/casino/mines/start", { bet, mines }, startKey);
      show(result.round, result.balance);
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function openTile(index: number) {
    if (!playing || busy || board[index] !== "hidden") return;
    slotSound.unlock();
    setBusy(true);
    try {
      const result = await send("/casino/mines/reveal", { tile: index }, stepKey);
      show(result.round, result.balance);
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  async function cashOut() {
    if (!playing || busy || (round?.opened ?? 0) === 0) return;
    slotSound.unlock();
    setBusy(true);
    try {
      const result = await send("/casino/mines/cashout", null, stepKey);
      show(result.round, result.balance);
    } catch (err) {
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  }

  useGameKeys(rulesOpen);

  if (!state) return <PageLoading label="Loading the Casino" />;

  const message = (() => {
    if (!round || (round.phase !== "PLAY" && round.opened === 0 && recent.length === 0)) return t("Pick the mines, then start.");
    if (round.phase === "PLAY" && round.opened === 0) return t("Tap a tile. A gem raises the multiplier.");
    if (round.phase === "PLAY") return t("Next tile {multiplier}×. Cash out {amount}.", { multiplier: round.nextMultiplier?.toFixed(2) ?? round.multiplier.toFixed(2), amount: formatMoney(round.cashout) });
    if (round.phase === "LOST") return t("Mine! The stake is lost.");
    if (round.capped) return t("That's the most a round pays: {amount}.", { amount: formatMoney(round.cashout) });
    if (round.opened === state.game.tiles - round.mines) return t("You cleared the board: {amount}.", { amount: formatMoney(round.cashout) });
    return t("Cashed out {amount} at {multiplier}×.", { amount: formatMoney(round.cashout), multiplier: round.multiplier.toFixed(2) });
  })();

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Mines")}</h1>
          <p className="muted report-subtitle">{t("Open the gems, cash out before a mine. Played with your balance.")}</p>
          <p className="game-keys-hint">{t("Press Space to start a round or cash out.")}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setRulesOpen(true)}>
          {t("Pays and rules")}
        </button>
      </div>

      {state.closed && !playing ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <section ref={cabinet} className={`mines-cabinet${fullScreen !== "off" ? " is-full" : ""}${boom ? " is-boom" : ""}`} aria-label={t("Mines")}>
          <header className="slot-marquee mines-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">{t("Mines")}</span>
            <button
              type="button"
              className="slot-fullscreen mines-sound"
              aria-pressed={soundOn}
              aria-label={soundOn ? t("Sound on. Tap to turn it off.") : t("Sound off. Tap to turn it on.")}
              title={soundOn ? t("Sound on. Tap to turn it off.") : t("Sound off. Tap to turn it on.")}
              onClick={() => {
                slotSound.setOn(!soundOn);
                setSoundOn(!soundOn);
                if (!soundOn) slotSound.click();
              }}
            >
              <span aria-hidden="true">{soundOn ? "🔊" : "🔇"}</span>
            </button>
            <button type="button" className="slot-fullscreen mines-rules" onClick={() => setRulesOpen(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
              ?
            </button>
            <button
              type="button"
              className="slot-fullscreen"
              onClick={() => void toggleFullScreen()}
              aria-label={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}
              title={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}
            >
              <FullScreenIcon exit={fullScreen !== "off"} />
            </button>
          </header>

          <div className="mines-stage">
            <div className="mines-readout" aria-live="polite">
              <span>
                <small>{t("Multiplier")}</small>
                <strong>{playing && round.opened === 0 ? "1.00×" : `${(round?.multiplier ?? 1).toFixed(2)}×`}</strong>
              </span>
              <span>
                <small>{t("Stake")}</small>
                <strong>{formatMoney(playing ? round.bet : bet)}</strong>
              </span>
              <span>
                <small>{playing ? t("Cash out") : t("Balance")}</small>
                <strong>{playing ? formatMoney(round.cashout) : formatMoney(balance)}</strong>
              </span>
            </div>
            <p className={`mines-message${round?.phase === "WON" ? " is-win" : ""}${round?.phase === "LOST" ? " is-loss" : ""}`}>{message}</p>
            <div className="mines-grid" style={{ gridTemplateColumns: `repeat(${state.game.columns}, 1fr)` }} role="group" aria-label={t("The field")}>
              {board.map((tile, index) => {
                const openable = playing && tile === "hidden" && !busy;
                const label = t("Tile {number}, {state}", { number: index + 1, state: tileName(tile, t) });
                return (
                  <button key={index} type="button" className={`mines-cell is-${tile}${fresh.has(index) ? " is-fresh" : ""}`} disabled={!openable} aria-label={label} onClick={() => void openTile(index)}>
                    <TileFace tile={tile} fresh={fresh.has(index)} />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mines-controls">
            <div className="mines-picks" role="radiogroup" aria-label={t("Mines")}>
              {state.game.mineCounts.map((count) => (
                <button key={count} type="button" className={`mines-pick${mines === count ? " is-on" : ""}`} aria-pressed={mines === count} disabled={playing || busy} onClick={() => setMines(count)}>
                  {count}
                </button>
              ))}
            </div>
            <div className="mines-picks" role="radiogroup" aria-label={t("Stake")}>
              {state.game.bets.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`mines-pick${bet === value ? " is-on" : ""}`}
                  aria-pressed={bet === value}
                  disabled={playing || busy || value > state.tableMax || value > balance}
                  onClick={() => setBet(value)}
                >
                  {formatMoney(value)}
                </button>
              ))}
            </div>
            {playing ? (
              <button type="button" className="mines-go" data-key="Space" disabled={busy || round.opened === 0} onClick={() => void cashOut()}>
                {round.opened === 0 ? t("Open a tile") : t("Cash out {amount}", { amount: formatMoney(round.cashout) })}
              </button>
            ) : (
              <button type="button" className="mines-go" data-key="Space" disabled={busy || bet <= 0 || bet > balance || bet > state.tableMax} onClick={() => void start()}>
                {t("Start {amount}", { amount: formatMoney(bet) })}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last rounds")}
          <HelpTip text="Your newest Mines rounds. They're also in My money, as one Mines line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No rounds yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((row) => (
              <div className="report-list-row" key={row.id}>
                <div>
                  <strong>{tn(row.mines, "{count} mine", "{count} mines")}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {tn(row.opened, "{count} gem", "{count} gems")} · {row.phase === "LOST" ? t("Mine") : `${row.multiplier.toFixed(2)}×`}
                  </span>
                </div>
                <strong className={row.phase === "LOST" ? "is-bad" : undefined}>{row.phase === "LOST" ? formatMoney(0) : formatMoney(row.cashout)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen ? (
        <div className="modal-backdrop" onClick={() => setRulesOpen(false)}>
          <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="mines-rules-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 id="mines-rules-title">{t("Pays and rules")}</h2>
              <button type="button" className="modal-close secondary" onClick={() => setRulesOpen(false)} aria-label={t("Close")}>
                ×
              </button>
            </div>
            <p>
              {t("A 5 by 5 field hides the number of mines you pick. Tap a tile: a gem raises what the round pays, a mine loses the stake. Cash out after the first gem, or keep going. The round ends on its own if you clear every gem, or if it reaches {times} times the stake.", { times: state.game.maxWin.toLocaleString() })}
            </p>
            <p>
              {t("Each gem pays the fair chance of having reached it, less 3%. Cents are rounded down. The stake is {min} to {max}, and never more than your max stake. A round left for an hour is cashed out, or the stake comes back if you hadn't opened a tile.", {
                min: formatMoney(state.game.bets[0]),
                max: formatMoney(state.game.bets[state.game.bets.length - 1]),
              })}
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function tileName(tile: MinesTile, t: (text: string) => string) {
  if (tile === "gem") return t("Gem");
  if (tile === "mine") return t("Mine");
  if (tile === "hit") return t("The mine you hit");
  return t("Hidden");
}

function TileFace({ tile, fresh }: { tile: MinesTile; fresh: boolean }) {
  if (tile === "hidden") return <span className="mines-stone" aria-hidden="true" />;
  if (tile === "gem") return <CoinBurst fresh={fresh} />;
  return <BombBlast hit={tile === "hit"} fresh={fresh} />;
}

function CoinBurst({ fresh }: { fresh: boolean }) {
  return (
    <span className={`mines-coins${fresh ? " is-fresh" : ""}`} aria-hidden="true">
      <span className="mines-coin-stack">
        <i />
        <i />
        <i />
      </span>
      {fresh
        ? COIN_BURST.map(([x, y], index) => <i key={index} className="mines-fly" style={{ "--dx": x, "--dy": y } as CSSProperties} />)
        : null}
    </span>
  );
}

function BombBlast({ hit, fresh }: { hit: boolean; fresh: boolean }) {
  const exploding = hit && fresh;
  const arriving = fresh && !hit;
  return (
    <span className={`mines-blast${hit ? " is-hit" : ""}${exploding ? " is-exploding" : ""}${arriving ? " is-fresh" : ""}`} aria-hidden="true">
      <span className="mines-bomb-body" />
      <span className="mines-fuse" />
      {exploding ? (
        <>
          <span className="mines-flash" />
          <span className="mines-shock" />
          <span className="mines-smoke" />
          {BLAST_SHARDS.map(([x, y], index) => (
            <i key={index} className="mines-shard" style={{ "--dx": x, "--dy": y } as CSSProperties} />
          ))}
        </>
      ) : null}
    </span>
  );
}
