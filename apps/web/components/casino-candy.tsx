"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CANDY_NAMES, CandyDefs, CandyIcon } from "./candy-symbols";
import { HouseHistory, HousePage, RulesSheet, useHouseGame } from "./house-game";
import { useI18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { slotSound } from "./slot-sounds";
import { useCasinoSession } from "./use-casino-session";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import type { CandyCell, CandyMode, CandyPaying, CandyRecord, CandySpinResult, CandyState, CandyStep } from "../lib/api";
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
/** Turbo (Space held): every pause this much shorter. */
const TURBO = 0.35;
const AUTO_COUNTS = [10, 25, 50, 100] as const;
/** What each way to play costs, in times the bet, if the API doesn't say. */
const COST: Record<CandyMode, number> = { NORMAL: 1, ANTE: 1.25, BUY: 100, SUPER: 240 };
const MAX_BUY_BET = 500;

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

/** The round arrows on the spin button. */
function SpinArrows() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="candy-spin-arrows">
      <path d="M38 20a15 15 0 0 0-27-6" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M8 7v9h9" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 28a15 15 0 0 0 27 6" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M40 41v-9h-9" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The Special Bet's slide switch: a pink candy knob that moves across when it's on. */
function AnteSwitch({ on, disabled, onToggle, label }: { on: boolean; disabled: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`candy-switch${on ? " is-on" : ""}`} disabled={disabled} onClick={onToggle}>
      <span className="candy-switch-knob" aria-hidden="true">
        →
      </span>
    </button>
  );
}

/** Candy Cascade for a Player: 8 or more of a candy anywhere pay, winners burst and new candies tumble in. */
export function CandyGame() {
  useCasinoSession("candy", "Candy Cascade");
  const { t, tn } = useI18n();
  const g = useHouseGame<CandyState>("/casino/candy");
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();
  const [shown, setShown] = useState<Shown[]>(() => landed(quietBoard(), 0).map((s) => ({ ...s, drop: 0 })));
  const [message, setMessage] = useState<{ text: string; tone?: "win" | "big" | "free" } | null>(null);
  const [roundWin, setRoundWin] = useState(0);
  const [free, setFree] = useState<{ left: number; won: number } | null>(null);
  const [multiplier, setMultiplier] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rules, setRules] = useState(false);
  const [autoLeft, setAutoLeft] = useState(0);
  const [autoMenu, setAutoMenu] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [turbo, setTurbo] = useState(false);
  /** The Special Bet: on, every spin costs 25% more and lands lollipops more often. */
  const [ante, setAnte] = useState(false);
  /** The Buy Feature menu: closed, open, or a purchase to confirm. */
  const [buying, setBuying] = useState<null | "menu" | "BUY" | "SUPER">(null);
  const skip = useRef(false);
  const alive = useRef(true);
  const keyRef = useRef(1000);
  const autoRef = useRef(0);
  autoRef.current = autoLeft;
  /** Space held down: spins follow one another at turbo speed until it's let go. */
  const held = useRef(false);
  const speed = useRef(1);

  useEffect(() => {
    alive.current = true;
    setSoundOn(slotSound.on);
    return () => {
      alive.current = false;
    };
  }, []);

  /** Waits (shorter in turbo), unless the Player asked to skip to the end or the page is hidden. */
  const wait = useCallback((ms: number) => (skip.current || document.hidden ? Promise.resolve() : new Promise<void>((resolve) => window.setTimeout(resolve, ms * speed.current))), []);

  /** Plays a round back from what the API sent: every spin, every tumble. */
  const playBack = useCallback(
    async (result: CandySpinResult) => {
      const bet = result.bet;
      let total = 0;
      let freeLeft = result.round.bought ?? 0;
      const spins = result.round.spins;
      if (freeLeft > 0) {
        setFree({ left: freeLeft, won: 0 });
        setMessage({ text: result.round.mode === "SUPER" ? t("{count} super free spins!", { count: freeLeft }) : t("{count} free spins!", { count: freeLeft }), tone: "free" });
        slotSound.win(true);
        await wait(1300);
      }
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
      } else setMessage(null);
    },
    [t, wait],
  );

  const costTable = g.state?.game.cost ?? COST;
  const costOf = useCallback((mode: CandyMode) => Math.round(g.stake * 100 * costTable[mode]) / 100, [g.stake, costTable]);
  const spinMode: CandyMode = ante ? "ANTE" : "NORMAL";
  /** Why a spin can't be played now: the bet over the max, or (with the Special Bet's 25%) over the balance. */
  const problem = g.stakeProblem ?? (g.state && costOf(spinMode) > g.balance + 1e-9 ? t("Your balance is too low for this stake.") : null);

  const play = useCallback(async (mode: CandyMode) => {
    if (!g.state) return;
    if (playing) {
      // A second press while it plays: straight to the end.
      skip.current = true;
      return;
    }
    if (mode === spinMode ? problem : costOf(mode) > g.balance + 1e-9) return;
    skip.current = false;
    setAutoMenu(false);
    setPlaying(true);
    g.setBusy(true);
    slotSound.unlock();
    setMessage(null);
    setRoundWin(0);
    const bet = g.stake;
    const cost = costOf(mode);
    const response = await g.send<CandySpinResult>("spin", { bet, mode });
    if (!response) {
      setPlaying(false);
      g.setBusy(false);
      setAutoLeft(0);
      held.current = false;
      return;
    }
    const paid = response.cost ?? cost;
    g.setBalance(Math.round((g.balance - paid) * 100) / 100);
    await playBack(response);
    if (!alive.current) return;
    g.setBalance(response.balance);
    g.tally(paid, response.win);
    g.setState((current) =>
      current
        ? { ...current, balance: response.balance, recent: [{ id: response.id, bet: paid, win: response.win, round: { game: "candy" as const, win: response.round.win, freeSpins: response.round.freeSpins, capped: response.round.capped, mode, bet }, createdAt: new Date().toISOString() }, ...current.recent].slice(0, 20) }
        : current,
    );
    skip.current = false;
    setPlaying(false);
    g.setBusy(false);
  }, [g, playBack, playing, spinMode, problem, costOf]);

  const spin = useCallback(() => play(spinMode), [play, spinMode]);

  // Autoplay, and Space held down: the next spin once one ends.
  useEffect(() => {
    if (playing || !g.state) return;
    if (autoLeft <= 0 && !held.current) return;
    if (problem) {
      setAutoLeft(0);
      held.current = false;
      return;
    }
    const timer = window.setTimeout(
      () => {
        if (autoRef.current > 0) setAutoLeft((left) => left - 1);
        else if (!held.current) return;
        void spin();
      },
      held.current ? 120 : 500,
    );
    return () => window.clearTimeout(timer);
  }, [playing, autoLeft, g.state, problem, spin, turbo]);

  // Space: a press spins (or skips to the end); held down, it keeps spinning in turbo until it's let go.
  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    };
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typing(event.target)) return;
      event.preventDefault();
      if (event.repeat) {
        if (!held.current) {
          held.current = true;
          speed.current = TURBO;
          setTurbo(true);
        }
        return;
      }
      void spin();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      held.current = false;
      speed.current = 1;
      setTurbo(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [spin]);

  const state = g.state;
  const payRows = useMemo(() => (state ? state.game.paying.map((symbol) => [symbol, state.game.pays[symbol]] as [CandyPaying, [number, number, number]]) : []), [state]);
  const allowed = useMemo(() => (state ? state.game.bets.filter((value) => value <= state.tableMax) : []), [state]);

  if (!state) return <PageLoading label="Loading the Casino" />;
  const stakeIndex = allowed.indexOf(g.stake);
  const stepStake = (by: number) => {
    const next = allowed[stakeIndex + by];
    if (next === undefined || playing || autoLeft > 0) return;
    g.setStake(next);
    slotSound.click();
  };
  const hint = turbo ? t("Turbo spin") : t("Hold Space for turbo spin");
  const maxBuyBet = state.game.maxBuyBet ?? MAX_BUY_BET;
  const buyNote = g.stake > maxBuyBet ? t("Bets up to {amount}", { amount: formatMoney(maxBuyBet) }) : null;
  const canBuy = !playing && autoLeft === 0 && !free && !buyNote && !!state.game.cost;
  const toggleAnte = () => {
    setAnte((on) => !on);
    slotSound.click();
  };

  return (
    <HousePage
      title="Candy Cascade"
      intro={t("8 or more of a candy anywhere pay. Winners burst and new candies tumble in.")}
      closed={state.closed}
      onRules={() => setRules(true)}
      cabinet={
        <section ref={cabinet} className={`candy-cabinet${fullScreen !== "off" ? " is-full" : ""}${free ? " is-free" : ""}`} aria-label="Candy Cascade">
          <CandyDefs />
          <header className="candy-top">
            <Link className="candy-round-key candy-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <p className="candy-headline">
              {t("Win up to {times}× bet", { times: state.game.maxWin.toLocaleString() })}
            </p>
          </header>

          <div className="candy-middle">
            {/* Beside the board on a wide screen: Buy Feature, the Special Bet, and the win or the free spins. */}
            <aside className="candy-side">
              <button type="button" className="candy-box is-buy" onClick={() => setBuying("menu")} disabled={!canBuy} title={buyNote ?? undefined}>
                <strong>{t("Buy feature")}</strong>
                <small>{buyNote ?? t("2 options")}</small>
              </button>
              <div className={`candy-box is-ante${ante ? " is-on" : ""}`}>
                <strong>{t("Special Bet")}</strong>
                <small>{t("Double chance · +25%")}</small>
                <AnteSwitch on={ante} disabled={playing || autoLeft > 0 || !!free} onToggle={toggleAnte} label={t("Special Bet")} />
              </div>
              <div className={`candy-box is-info${free ? " is-free" : ""}`} aria-live="polite">
                {free ? (
                  <>
                    <small>{t("Free spins")}</small>
                    <strong className="candy-side-big">{free.left}</strong>
                    <small>{t("Total win")}</small>
                    <strong>{formatMoney(free.won)}</strong>
                  </>
                ) : (
                  <>
                    <small>{t("Win")}</small>
                    <strong className="candy-side-big is-money">{formatMoney(roundWin)}</strong>
                  </>
                )}
              </div>
            </aside>

            <div className="candy-board-wrap">
              {/* On a phone: Buy Feature and the Special Bet, small, over the board. */}
              <div className="candy-extras">
                <button type="button" className="candy-chip is-buy" onClick={() => setBuying("menu")} disabled={!canBuy}>
                  {t("Buy feature")}
                </button>
                <span className={`candy-chip is-ante${ante ? " is-on" : ""}`}>
                  {t("Special Bet")}
                  <AnteSwitch on={ante} disabled={playing || autoLeft > 0 || !!free} onToggle={toggleAnte} label={t("Special Bet")} />
                </span>
              </div>
              {!free ? (
                <div className="candy-phone-win" aria-hidden="true">
                  {t("Win")} <span>{formatMoney(roundWin)}</span>
                </div>
              ) : null}
              {free ? (
                <div className="candy-free-strip" aria-hidden="true">
                  {tn(free.left, "{count} free spin left", "{count} free spins left")} · {formatMoney(free.won)}
                </div>
              ) : null}
              <div className={`candy-board${free ? " is-free" : ""}`} role="img" aria-label={t("The board")}>
                {Array.from({ length: COLUMNS }, (_, column) => (
                  <div className="candy-column" key={column}>
                    {Array.from({ length: ROWS }, (_, row) => {
                      const cell = shown[at(column, row)];
                      return (
                        <span
                          key={cell.key}
                          className={`candy-cell${cell.win ? " is-win" : ""}${cell.burst ? " is-burst" : ""}${cell.drop > 0 ? " is-dropping" : ""}`}
                          style={{ "--drop": cell.drop, "--col": column, "--speed": turbo ? TURBO : 1 } as CSSProperties}
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
            </div>
          </div>

          <footer className="candy-bar">
            <div className="candy-keys">
              <button type="button" className="candy-round-key" onClick={() => setRules(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
                i
              </button>
              <button
                type="button"
                className="candy-round-key"
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
              <button type="button" className="candy-round-key" onClick={() => void toggleFullScreen()} aria-label={fullScreen === "off" ? t("Full screen") : t("Exit full screen")} title={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}>
                <FullScreenIcon exit={fullScreen !== "off"} />
              </button>
            </div>

            <dl className="candy-money">
              <div>
                <dt>{t("Credit")}</dt>
                <dd>{formatMoney(g.balance)}</dd>
              </div>
              <div>
                <dt>{t("Bet")}</dt>
                <dd>{formatMoney(costOf(spinMode))}</dd>
              </div>
            </dl>

            <p className={`candy-say${message?.tone ? ` is-${message.tone}` : ""}`} aria-live="polite">
              {problem && !playing ? problem : message ? message.text : <span className="candy-hint">{hint}</span>}
            </p>

            <div className="candy-spin-group">
              <button type="button" className="candy-step" onClick={() => stepStake(-1)} disabled={playing || autoLeft > 0 || stakeIndex <= 0} aria-label={t("Lower the bet")}>
                −
              </button>
              <div className="candy-spin-stack">
                <button type="button" className={`candy-spin${playing ? " is-spinning" : ""}`} disabled={!!problem && !playing} onClick={() => void spin()} aria-label={playing ? t("Skip") : t("Spin {amount}", { amount: formatMoney(g.stake) })}>
                  <SpinArrows />
                </button>
                {autoLeft > 0 ? (
                  <button type="button" className="candy-auto-pill is-on" onClick={() => setAutoLeft(0)}>
                    {t("Stop ({count} left)", { count: autoLeft })}
                  </button>
                ) : (
                  <button type="button" className="candy-auto-pill" disabled={playing || !!problem} aria-expanded={autoMenu} onClick={() => setAutoMenu((open) => !open)}>
                    {t("Autoplay")}
                  </button>
                )}
                {autoMenu && autoLeft === 0 ? (
                  <div className="candy-auto-menu" role="menu" aria-label={t("Spins to play")}>
                    {AUTO_COUNTS.map((count) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={count}
                        onClick={() => {
                          setAutoMenu(false);
                          setAutoLeft(count);
                        }}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button type="button" className="candy-step" onClick={() => stepStake(1)} disabled={playing || autoLeft > 0 || stakeIndex >= allowed.length - 1} aria-label={t("Raise the bet")}>
                +
              </button>
            </div>
          </footer>

          {buying ? (
            <div className="candy-buy-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setBuying(null)}>
              <div className="candy-buy" role="dialog" aria-modal="true" aria-label={t("Buy feature")}>
                <button type="button" className="candy-round-key candy-buy-close" onClick={() => setBuying(null)} aria-label={t("Close")}>
                  ×
                </button>
                <h2>{t("Buy feature")}</h2>
                {buying === "menu" ? (
                  <div className="candy-buy-options">
                    {(["BUY", "SUPER"] as const).map((mode) => (
                      <button type="button" key={mode} className={`candy-buy-option is-${mode.toLowerCase()}`} onClick={() => setBuying(mode)} disabled={costOf(mode) > g.balance + 1e-9}>
                        <strong>{mode === "SUPER" ? t("Super free spins") : t("Free spins")}</strong>
                        <span>{mode === "SUPER" ? t("{count} free spins, every multiplier candy {min}× or more", { count: state.game.freeSpins, min: (state.game.superMultipliers ?? [5])[0] }) : t("{count} free spins, straight away", { count: state.game.freeSpins })}</span>
                        <b>{formatMoney(costOf(mode))}</b>
                        {costOf(mode) > g.balance + 1e-9 ? <small>{t("Your balance is too low for this.")}</small> : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="candy-buy-confirm">
                    <p>
                      {t("Buy {what} for {amount}?", { what: buying === "SUPER" ? t("super free spins") : t("free spins"), amount: formatMoney(costOf(buying)) })}
                    </p>
                    <p className="candy-buy-small">{t("That's {times}× your bet of {bet}. The free spins play out at that bet.", { times: costTable[buying], bet: formatMoney(g.stake) })}</p>
                    <div className="candy-buy-actions">
                      <button type="button" className="candy-buy-cancel" onClick={() => setBuying("menu")}>
                        {t("Back")}
                      </button>
                      <button
                        type="button"
                        className="candy-buy-go"
                        onClick={() => {
                          const mode = buying;
                          setBuying(null);
                          void play(mode);
                        }}
                      >
                        {t("Buy for {amount}", { amount: formatMoney(costOf(buying)) })}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>
      }
      history={
        <HouseHistory<CandyRecord>
          title="Your last spins"
          help="Your newest Candy Cascade spins, with the free spins they gave. They're also in My money, as one Candy Cascade line for each day."
          empty="No spins yet."
          rows={state.recent}
          describe={(round) => ({
            head: round && round.win > 0 ? `${Math.round(round.win * 100) / 100}×` : "—",
            detail: [
              round?.mode === "BUY" ? t("Bought free spins") : round?.mode === "SUPER" ? t("Bought super free spins") : round?.mode === "ANTE" ? t("Special Bet") : t("Spin"),
              ...(round && round.freeSpins > 0 && round.mode !== "BUY" && round.mode !== "SUPER" ? [tn(round.freeSpins, "{count} free spin", "{count} free spins")] : []),
            ].join(" · "),
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
            <p>
              <strong>{t("Special Bet")}:</strong>{" "}
              {t("turned on, each spin costs 25% more ({amount} at your bet) and lands lollipops more often: free spins come about twice as often. Wins are counted from your bet, as usual.", { amount: formatMoney(costOf("ANTE")) })}
            </p>
            <p>
              <strong>{t("Buy feature")}:</strong>{" "}
              {t("start {count} free spins straight away for {buy}× your bet, or {count} super free spins (every multiplier candy {min}× or more) for {super}×. Free spins can be bought at bets up to {max}, and ask you to confirm first.", {
                count: state.game.freeSpins,
                buy: costTable.BUY,
                super: costTable.SUPER,
                min: (state.game.superMultipliers ?? [5])[0],
                max: formatMoney(state.game.maxBuyBet ?? MAX_BUY_BET),
              })}
            </p>
            <p>{t("Spin with the round button, or press Space; press again to skip to the end. Hold Space down for turbo spins, one after another, until you let go. − and + change the bet; Autoplay plays 10 to 100 spins.")}</p>
            <p>{t("A spin, with every free spin it gives, pays at most {times} times the stake. The free spins play out with the spin that gave them, so a spin is settled at once, even if you leave.", { times: state.game.maxWin.toLocaleString() })}</p>
          </RulesSheet>
        ) : null
      }
    />
  );
}
