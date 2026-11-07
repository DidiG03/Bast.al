"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CANDY_NAMES, CandyDefs, CandyIcon } from "./candy-symbols";
import { HouseCabinet, HouseHistory, HousePage, RulesSheet, StakeChips, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import type { CandyCell, CandyPaying, CandyRecord, CandySpinResult, CandyState, CandyStep } from "../lib/api";
import { formatMoney } from "../lib/format";

const COLUMNS = 6;
const ROWS = 5;
/** How long each part of a spin shows, ms: the board dropping in, the winners glowing, bursting, the rest falling. */
const DROP_MS = 420;
const GLOW_MS = 650;
const BURST_MS = 260;
const SETTLE_MS = 180;
const MULTIPLIER_MS = 1100;
const BETWEEN_FREE_MS = 450;
const AUTO_COUNTS = [10, 25, 50, 100] as const;

/** A cell as the board shows it: its candy, how many rows it falls from, and whether it's in a win or bursting. */
type Shown = { cell: CandyCell; drop: number; win: boolean; burst: boolean; key: number };

const at = (column: number, row: number) => column * ROWS + row;

/** A board as it first lands: every candy falls in from above. */
function landed(board: CandyCell[], keyBase: number): Shown[] {
  return board.map((cell, index) => ({ cell, drop: ROWS, win: false, burst: false, key: keyBase + index }));
}

/**
 * The board after a tumble: in each column the candies that stayed fall by as many rows as burst under them,
 * and the new ones fall in from above the board.
 */
function tumbled(previous: Shown[], step: CandyStep, next: CandyCell[], keyBase: number): Shown[] {
  const gone = new Set(step.wins.flatMap((win) => win.cells));
  const shown: Shown[] = [];
  for (let column = 0; column < COLUMNS; column++) {
    const kept: Shown[] = [];
    for (let row = 0; row < ROWS; row++) if (!gone.has(at(column, row))) kept.push(previous[at(column, row)]);
    const fresh = ROWS - kept.length;
    for (let row = 0; row < ROWS; row++) {
      if (row < fresh) shown.push({ cell: next[at(column, row)], drop: fresh, win: false, burst: false, key: keyBase + at(column, row) });
      else {
        const old = kept[row - fresh];
        // It was at its old row; now it's `row`. Falls by the difference.
        const oldRow = previous.indexOf(old) - column * ROWS;
        shown.push({ ...old, cell: next[at(column, row)], drop: row - oldRow, win: false, burst: false });
      }
    }
  }
  return shown;
}

const quietBoard = (): CandyCell[] => Array.from({ length: COLUMNS * ROWS }, (_, i) => (["PEACH", "GRAPE", "MINT", "LEMON", "ORANGE", "GEM", "MOON", "STAR", "HEART"] as CandyCell[])[(i * 7) % 9]);

/** Candy Cascade for a Player: 8 or more of a candy anywhere pay, winners burst and new candies tumble in. */
export function CandyGame() {
  useCasinoSession("candy", "Candy Cascade");
  const { t, tn } = useI18n();
  const g = useHouseGame<CandyState>("/casino/candy");
  const [shown, setShown] = useState<Shown[]>(() => landed(quietBoard(), 0).map((s) => ({ ...s, drop: 0 })));
  const [message, setMessage] = useState<{ text: string; tone?: "win" | "big" | "free" } | null>(null);
  const [roundWin, setRoundWin] = useState(0);
  const [free, setFree] = useState<{ left: number; won: number } | null>(null);
  const [multiplier, setMultiplier] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rules, setRules] = useState(false);
  const [autoLeft, setAutoLeft] = useState(0);
  const [autoCount, setAutoCount] = useState<number>(AUTO_COUNTS[0]);
  const skip = useRef(false);
  const alive = useRef(true);
  const keyRef = useRef(1000);
  const autoRef = useRef(0);
  autoRef.current = autoLeft;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Waits, unless the Player asked to skip to the end or the page is hidden. */
  const wait = useCallback((ms: number) => (skip.current || document.hidden ? Promise.resolve() : new Promise<void>((resolve) => window.setTimeout(resolve, ms))), []);

  /** Plays a round back from what the API sent: every spin, every tumble. */
  const playBack = useCallback(
    async (result: CandySpinResult) => {
      const bet = result.bet;
      let total = 0;
      let freeLeft = 0;
      const spins = result.round.spins;
      for (let s = 0; s < spins.length && alive.current; s++) {
        const spin = spins[s];
        if (spin.free) {
          freeLeft -= 1;
          setFree((current) => ({ left: Math.max(0, freeLeft), won: current?.won ?? 0 }));
          await wait(BETWEEN_FREE_MS);
        }
        setMultiplier(null);
        setMessage(null);
        keyRef.current += 100;
        let board = landed(spin.steps[0].board, keyRef.current);
        setShown(board);
        slotSound.spinStart();
        await wait(DROP_MS);
        let spinWin = 0;
        for (let i = 0; i < spin.steps.length && alive.current; i++) {
          const step = spin.steps[i];
          if (step.wins.length === 0) break;
          const winning = new Set(step.wins.flatMap((win) => win.cells));
          board = board.map((cell, index) => ({ ...cell, drop: 0, win: winning.has(index) }));
          setShown(board);
          const stepPay = step.wins.reduce((sum, win) => sum + win.pay, 0);
          spinWin += stepPay;
          setMessage({ text: step.wins.map((win) => `${win.count} × ${t(CANDY_NAMES[win.symbol])}: ${formatMoney(win.pay * bet)}`).join(" · "), tone: "win" });
          setRoundWin(Math.round((total + spinWin * bet) * 100) / 100);
          slotSound.win(stepPay >= 5);
          await wait(GLOW_MS);
          board = board.map((cell) => ({ ...cell, burst: cell.win }));
          setShown(board);
          await wait(BURST_MS);
          keyRef.current += 100;
          board = tumbled(board, step, spin.steps[i + 1].board, keyRef.current);
          setShown(board);
          await wait(DROP_MS + SETTLE_MS);
        }
        // A free spin that won: the multipliers on the board add up.
        if (spin.free && spin.multiplier > 1 && spin.tumbleWin > 0) {
          setMultiplier(spin.multiplier);
          setMessage({ text: t("{win} × {multiplier} = {total}", { win: formatMoney(spin.tumbleWin * bet), multiplier: spin.multiplier, total: formatMoney(spin.tumbleWin * spin.multiplier * bet) }), tone: "big" });
          slotSound.win(true);
          await wait(MULTIPLIER_MS);
        }
        if (spin.scatterPay > 0) {
          setMessage({ text: t("{count} lollipops: {amount}", { count: spin.scatters, amount: formatMoney(spin.scatterPay * bet) }), tone: "win" });
          await wait(GLOW_MS);
        }
        total = Math.round((total + spin.win * bet) * 100) / 100;
        setRoundWin(total);
        if (spin.freeSpinsWon > 0) {
          freeLeft += spin.freeSpinsWon;
          setFree((current) => ({ left: freeLeft, won: current?.won ?? 0 }));
          setMessage({ text: spin.free ? t("+{count} free spins!", { count: spin.freeSpinsWon }) : t("{count} free spins!", { count: spin.freeSpinsWon }), tone: "free" });
          slotSound.win(true);
          await wait(1400);
        }
        if (spin.free) setFree((current) => (current ? { ...current, won: Math.round((current.won + spin.win * bet) * 100) / 100 } : current));
      }
      setMultiplier(null);
      setFree(null);
      const won = result.win;
      setRoundWin(won);
      if (won > 0) {
        const times = Math.round((won / bet) * 100) / 100;
        setMessage({ text: result.round.capped ? t("Top win! {amount}", { amount: formatMoney(won) }) : times >= 20 ? t("Big win! {amount} ({times}×)", { amount: formatMoney(won), times }) : t("You won {amount}", { amount: formatMoney(won) }), tone: times >= 20 ? "big" : "win" });
      } else setMessage({ text: t("No win this time"), tone: undefined });
    },
    [t, wait],
  );

  const spin = useCallback(async () => {
    if (!g.state || g.stakeProblem) return;
    if (playing) {
      // A second press while it plays: straight to the end.
      skip.current = true;
      return;
    }
    skip.current = false;
    setPlaying(true);
    g.setBusy(true);
    slotSound.unlock();
    setMessage(null);
    setRoundWin(0);
    const bet = g.stake;
    const response = await g.send<CandySpinResult>("spin", { bet });
    if (!response) {
      setPlaying(false);
      g.setBusy(false);
      setAutoLeft(0);
      return;
    }
    g.setBalance(Math.round((g.balance - bet) * 100) / 100);
    await playBack(response);
    if (!alive.current) return;
    g.setBalance(response.balance);
    g.tally(bet, response.win);
    g.setState((current) =>
      current
        ? { ...current, balance: response.balance, recent: [{ id: response.id, bet, win: response.win, round: { game: "candy" as const, win: response.round.win, freeSpins: response.round.freeSpins, capped: response.round.capped }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) }
        : current,
    );
    skip.current = false;
    setPlaying(false);
    g.setBusy(false);
  }, [g, playBack, playing]);

  // Autoplay: the next spin once one ends, while spins are left.
  useEffect(() => {
    if (playing || autoLeft <= 0 || !g.state) return;
    if (g.stakeProblem) {
      setAutoLeft(0);
      return;
    }
    const timer = window.setTimeout(() => {
      if (autoRef.current <= 0) return;
      setAutoLeft((left) => left - 1);
      void spin();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [playing, autoLeft, g.state, g.stakeProblem, spin]);

  // Space spins (or skips to the end), on a computer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName)) return;
      event.preventDefault();
      void spin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spin]);

  const state = g.state;
  const payRows = useMemo(() => (state ? state.game.paying.map((symbol) => [symbol, state.game.pays[symbol]] as [CandyPaying, [number, number, number]]) : []), [state]);

  if (!state) return <PageLoading label="Loading the Casino" />;
  const busy = playing;

  return (
    <HousePage
      title="Candy Cascade"
      intro={t("8 or more of a candy anywhere pay. Winners burst and new candies tumble in.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <HouseCabinet
          game="candy"
          title="Candy Cascade"
          balance={g.balance}
          visit={g.visit}
          onRules={() => setRules(true)}
          stage={
            <div className="candy-stage">
              <CandyDefs />
              <div className={`candy-banner${free ? " is-free" : ""}`} aria-live="polite">
                {free ? (
                  <>
                    <strong>{tn(free.left, "{count} free spin left", "{count} free spins left")}</strong>
                    <span>{t("Free spins win: {amount}", { amount: formatMoney(free.won) })}</span>
                  </>
                ) : (
                  <span>{t("Win: {amount}", { amount: formatMoney(roundWin) })}</span>
                )}
              </div>
              <div className={`candy-board${free ? " is-free" : ""}`} role="img" aria-label={t("The board")}>
                {Array.from({ length: COLUMNS }, (_, column) => (
                  <div className="candy-column" key={column}>
                    {Array.from({ length: ROWS }, (_, row) => {
                      const cell = shown[at(column, row)];
                      return (
                        <span
                          key={cell.key}
                          className={`candy-cell${cell.win ? " is-win" : ""}${cell.burst ? " is-burst" : ""}${cell.drop > 0 ? " is-dropping" : ""}`}
                          style={{ "--drop": cell.drop, "--col": column } as CSSProperties}
                        >
                          <CandyIcon cell={cell.cell} />
                        </span>
                      );
                    })}
                  </div>
                ))}
                {multiplier ? (
                  <div className="candy-multiplier-burst" aria-live="polite">
                    ×{multiplier}
                  </div>
                ) : null}
              </div>
              <p className={`house-result candy-message${message?.tone ? ` is-${message.tone}` : ""}`} aria-live="polite">
                {message ? message.text : t("Pick a stake, then spin.")}
              </p>
            </div>
          }
          controls={
            <>
              <button type="button" className="dice-go candy-go" disabled={!!g.stakeProblem && !playing} onClick={() => void spin()}>
                {playing ? t("Skip") : t("Spin {amount}", { amount: formatMoney(g.stake) })}
              </button>
              {g.stakeProblem ? <p className="dice-problem">{g.stakeProblem}</p> : null}
              <StakeChips bets={state.game.bets} tableMax={state.tableMax} stake={g.stake} onStake={g.setStake} disabled={busy || autoLeft > 0} />
              <div className="dice-field candy-auto">
                <small>{t("Autoplay")}</small>
                <div className="candy-auto-row">
                  <select value={autoCount} onChange={(event) => setAutoCount(Number(event.target.value))} disabled={autoLeft > 0} aria-label={t("Spins to play")}>
                    {AUTO_COUNTS.map((count) => (
                      <option key={count} value={count}>
                        {tn(count, "{count} spin", "{count} spins")}
                      </option>
                    ))}
                  </select>
                  {autoLeft > 0 ? (
                    <button type="button" className="secondary candy-auto-stop" onClick={() => setAutoLeft(0)}>
                      {t("Stop ({count} left)", { count: autoLeft })}
                    </button>
                  ) : (
                    <button type="button" className="secondary" disabled={busy || !!g.stakeProblem} onClick={() => setAutoLeft(autoCount)}>
                      {t("Start autoplay")}
                    </button>
                  )}
                </div>
              </div>
              <p className="game-keys-hint candy-keys">{t("Press Space to spin, and again to skip to the end.")}</p>
            </>
          }
        />
      }
      history={
        <HouseHistory<CandyRecord>
          title="Your last spins"
          help="Your newest Candy Cascade spins, with the free spins they gave. They're also in My money, as one Candy Cascade line for each day."
          empty="No spins yet."
          rows={state.recent}
          describe={(round) => ({
            head: round && round.win > 0 ? `${Math.round(round.win * 100) / 100}×` : "—",
            detail: round && round.freeSpins > 0 ? tn(round.freeSpins, "{count} free spin", "{count} free spins") : t("Spin"),
          })}
        />
      }
      rules={
        rules ? (
          <RulesSheet onClose={() => setRules(false)}>
            <CandyDefs />
            <p>{t("6 columns of 5 candies, and no lines: 8 or more of one candy anywhere on the board pay. The winning candies burst, the rest fall down and new candies drop in, and the board pays again for as long as it has a win.")}</p>
            <div className="candy-paytable">
              <div className="candy-paytable-head">
                <span />
                <small>8–9</small>
                <small>10–11</small>
                <small>12+</small>
              </div>
              {payRows.map(([symbol, pays]) => (
                <div className="candy-paytable-row" key={symbol}>
                  <span title={t(CANDY_NAMES[symbol])}>
                    <CandyIcon cell={symbol} />
                  </span>
                  {pays.map((pay, i) => (
                    <strong key={i}>{formatMoney(pay * g.stake)}</strong>
                  ))}
                </div>
              ))}
            </div>
            <p className="muted">{t("Pays shown for a stake of {amount}.", { amount: formatMoney(g.stake) })}</p>
            <p className="candy-rule-line">
              <CandyIcon cell="LOLLIPOP" />
              <span>
                {t("The lollipop pays anywhere, once the tumbles are over: 4 pay {four}, 5 pay {five}, 6 or more pay {six}. 4 or more give {count} free spins.", {
                  four: `${state.game.scatterPays["4"]}×`,
                  five: `${state.game.scatterPays["5"]}×`,
                  six: `${state.game.scatterPays["6"]}×`,
                  count: state.game.freeSpins,
                })}
              </span>
            </p>
            <p className="candy-rule-line">
              <CandyIcon cell="X10" />
              <span>
                {t("In free spins, multiplier candies from {min}× to {max}× drop in too, and stay. When a free spin's tumbles end with a win, every multiplier on the board adds up and multiplies that spin's win. {count} or more lollipops in a free spin give {more} more.", {
                  min: state.game.multipliers[0],
                  max: state.game.multipliers[state.game.multipliers.length - 1],
                  count: state.game.scattersForMore,
                  more: state.game.moreFreeSpins,
                })}
              </span>
            </p>
            <p>{t("A spin, with every free spin it gives, pays at most {times} times the stake. The free spins play out with the spin that gave them, so a spin is settled at once, even if you leave.", { times: state.game.maxWin.toLocaleString() })}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
