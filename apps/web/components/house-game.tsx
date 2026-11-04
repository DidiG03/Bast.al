"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Sheet } from "./fair-play";
import { LastSpins } from "./casino-last-spins";
import { useChipBalance } from "./balance-chip";
import { useI18n } from "./i18n-provider";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, useFullScreen } from "./use-full-screen";
import { apiFetch, newIdempotencyKey, type HouseBasics } from "../lib/api";
import { formatMoney, formatStake } from "../lib/format";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

/**
 * What every one of Crash, Baccarat, Hi-Lo, Money Wheel and Tower needs: the
 * table from the API, the balance (kept in step with the top bar), the stake,
 * this visit's result, and `send` for a move (with an Idempotency-Key, and
 * the error shown as a toast).
 */
export function useHouseGame<S extends HouseBasics<unknown> & { game: { bets: number[] } }>(path: string) {
  const { getToken } = useAuth();
  const { t, ts } = useI18n();
  const toast = useToast();
  const [state, setState] = useState<S | null>(null);
  const [balance, setBalance] = useState(0);
  const [stake, setStake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [visit, setVisit] = useState({ rounds: 0, profit: 0 });
  const busyRef = useRef(false);
  busyRef.current = busy;

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<S>(path, token);
    setState(next);
    setBalance(next.balance);
    const allowed = next.game.bets.filter((value) => value <= next.tableMax);
    setStake((current) => (allowed.includes(current) ? current : (allowed.filter((value) => value <= current).pop() ?? allowed[0] ?? next.game.bets[0])));
    return next;
  }, [getToken, path, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useChipBalance(state ? balance : null);
  useRealtime((event) => {
    if (event.type === "balance.changed" && !busyRef.current) setBalance(event.balance);
  });

  /** A move: POSTs `body` to `path + action`; null if it didn't go through (the toast says why). */
  const send = useCallback(
    async <R,>(action: string, body: object = {}, options: { idempotent?: boolean } = {}): Promise<R | null> => {
      try {
        const token = await getToken();
        if (!token) throw new Error(t("You're not signed in"));
        return await apiFetch<R>(`${path}/${action}`, token, { method: "POST", body: JSON.stringify(body), ...(options.idempotent === false ? {} : { idempotencyKey: newIdempotencyKey() }) });
      } catch (err) {
        toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
        return null;
      }
    },
    [getToken, path, t, ts, toast],
  );

  /** Adds a finished round to this visit's tally. */
  const tally = useCallback((bet: number, win: number) => setVisit((v) => ({ rounds: v.rounds + 1, profit: Math.round((v.profit + win - bet) * 100) / 100 })), []);

  const stakeProblem = !state ? null : stake > state.tableMax ? t("The most you can bet on one round is {amount}.", { amount: formatMoney(state.tableMax) }) : stake > balance + 1e-9 ? t("Your balance is too low for this stake.") : null;

  return { state, setState, load, balance, setBalance, stake, setStake, busy, setBusy, visit, tally, send, stakeProblem };
}

/** The cabinet every new game sits in: the bar with the way out, sound, rules and full screen; the readout; the stage; the controls. */
export function HouseCabinet({
  game,
  title,
  balance,
  visit,
  onRules,
  stage,
  controls,
}: {
  game: string;
  title: string;
  balance: number;
  visit: { rounds: number; profit: number };
  onRules: () => void;
  stage: ReactNode;
  controls: ReactNode;
}) {
  const { t } = useI18n();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(slotSound.on), []);
  return (
    <section ref={cabinet} className={`dice-cabinet house-cabinet is-${game}${fullScreen !== "off" ? " is-full" : ""}`} aria-label={title}>
      <header className="slot-marquee dice-marquee house-marquee">
        <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
          ‹
        </Link>
        <span className="slot-title">{title}</span>
        <button
          type="button"
          className="slot-fullscreen dice-sound"
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
        <button type="button" className="slot-fullscreen dice-rules" onClick={onRules} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
          ?
        </button>
        <button type="button" className="slot-fullscreen" onClick={() => void toggleFullScreen()} aria-label={fullScreen === "off" ? t("Full screen") : t("Exit full screen")} title={fullScreen === "off" ? t("Full screen") : t("Exit full screen")}>
          <FullScreenIcon exit={fullScreen !== "off"} />
        </button>
      </header>
      <div className="dice-body">
        <div className="dice-stage house-stage">
          <div className="dice-readout">
            <span>
              <small>{t("Balance")}</small>
              <strong>{formatMoney(balance)}</strong>
            </span>
            <span>
              <small>{t("This visit")}</small>
              <strong className={visit.profit < 0 ? "is-loss" : visit.profit > 0 ? "is-win" : undefined}>
                {visit.profit > 0 ? "+" : ""}
                {formatMoney(visit.profit)}
              </strong>
            </span>
            <span>
              <small>{t("Rounds")}</small>
              <strong>{visit.rounds}</strong>
            </span>
          </div>
          {stage}
        </div>
        <div className="dice-controls">{controls}</div>
      </div>
    </section>
  );
}

/** The stake chips, within the Player's max stake. */
export function StakeChips({ bets, tableMax, stake, onStake, disabled }: { bets: number[]; tableMax: number; stake: number; onStake: (value: number) => void; disabled: boolean }) {
  const { t } = useI18n();
  return (
    <div className="dice-field">
      <small>{t("Stake")}</small>
      <div className="keno-bets dice-bets" role="radiogroup" aria-label={t("Stake")}>
        {bets
          .filter((value) => value <= tableMax)
          .map((value) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={stake === value}
              className={stake === value ? "is-on" : undefined}
              disabled={disabled}
              onClick={() => {
                onStake(value);
                slotSound.click();
              }}
            >
              {formatStake(value)}
            </button>
          ))}
      </div>
    </div>
  );
}

/** A choice row (risk, side, difficulty): buttons, one on. */
export function ChoiceRow<T extends string>({ label, options, value, onChange, disabled }: { label: string; options: Array<[T, ReactNode]>; value: T; onChange: (value: T) => void; disabled: boolean }) {
  return (
    <div className="dice-field">
      <small>{label}</small>
      <div className="house-choices" role="radiogroup" aria-label={label}>
        {options.map(([key, content]) => (
          <button
            type="button"
            key={key}
            role="radio"
            aria-checked={value === key}
            className={value === key ? "is-on" : undefined}
            disabled={disabled}
            onClick={() => {
              onChange(key);
              slotSound.click();
            }}
          >
            {content}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The last rounds, under the cabinet. `describe` gives each row's headline and details. */
export function HouseHistory<R>({ title, help, empty, rows, describe }: { title: string; help: string; empty: string; rows: Array<{ id: string; bet: number; win: number; round: R | null; createdAt: string }>; describe: (round: R | null) => { head: string; detail: string } }) {
  const { t, date } = useI18n();
  return (
    <LastSpins title={title} help={help}>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>{t(empty)}</p>
      ) : (
        <div className="report-list">
          {rows.map((row) => {
            const { head, detail } = describe(row.round);
            const won = row.win > row.bet;
            return (
              <div className="report-list-row dice-row" key={row.id}>
                <div>
                  <strong className={row.win > 0 ? "is-good" : "is-bad"}>{head}</strong>
                  <span className="muted">
                    {date(row.createdAt, TIME)} · {detail} · {t("{amount} stake", { amount: formatMoney(row.bet) })}
                  </span>
                </div>
                <strong className={row.win === 0 ? "is-bad" : won ? undefined : undefined}>{formatMoney(row.win)}</strong>
              </div>
            );
          })}
        </div>
      )}
    </LastSpins>
  );
}

/** The rules sheet. */
export function RulesSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <Sheet title={t("Pays and rules")} onClose={onClose}>
      {children}
    </Sheet>
  );
}

/** The page around a cabinet: the title line, the closed note, the history and the rules. */
export function HousePage({ title, intro, closed, onRules, cabinet, history, rules }: { title: string; intro: string; closed: string | null; onRules: () => void; cabinet: ReactNode; history: ReactNode; rules: ReactNode }) {
  const { t, ts } = useI18n();
  return (
    <div className="stack casino-page">
      <div className="page-title-row">
        <div>
          <div className="game-title-line">
            <h1 style={{ margin: 0 }}>{title}</h1>
            <button type="button" className="game-rules-button" onClick={onRules} aria-label={t("Pays and rules")}>
              ?
            </button>
          </div>
          <p className="muted report-subtitle">{intro}</p>
        </div>
      </div>
      {closed ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(closed)}</p>
        </div>
      ) : (
        cabinet
      )}
      {history}
      {rules}
    </div>
  );
}

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

/** A playing card, face up (or its back). */
export function PlayingCardView({ card, back, small, highlight }: { card?: { rank: number; suit: number } | null; back?: boolean; small?: boolean; highlight?: "win" | "loss" | null }) {
  if (!card || back) return <span className={`house-card is-back${small ? " is-small" : ""}`} aria-hidden="true" />;
  const red = card.suit === 1 || card.suit === 2;
  return (
    <span className={`house-card${red ? " is-red" : ""}${small ? " is-small" : ""}${highlight ? ` is-${highlight}` : ""}`} role="img" aria-label={`${RANKS[card.rank]}${SUITS[card.suit]}`}>
      <span className="house-card-rank">{RANKS[card.rank]}</span>
      <span className="house-card-suit">{SUITS[card.suit]}</span>
    </span>
  );
}

export const cardName = (card: { rank: number; suit: number }) => `${RANKS[card.rank]}${SUITS[card.suit]}`;
