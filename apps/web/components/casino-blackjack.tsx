"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { HelpTip } from "./help-tip";
import { useI18n, type I18n } from "./i18n-provider";
import { PageLoading } from "./loading-spinner";
import { useRealtime } from "./realtime-provider";
import { slotSound } from "./slot-sounds";
import { useToast } from "./toaster";
import { FullScreenIcon, RotatePhoneIcon, useFullScreen, usePrefersReducedMotion } from "./use-full-screen";
import { useGameKeys } from "./use-game-keys";
import { apiFetch, type BlackjackAction, type BlackjackMoveResult, type BlackjackRoundView, type BlackjackState } from "../lib/api";
import { SUIT_SYMBOLS, handTotal, isRedSuit, rankLabel } from "../lib/blackjack";
import { formatMoney } from "../lib/format";
import { useIdempotencyKey } from "../lib/use-idempotency-key";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
/** The dealer's chip tray, decoration only: a row of stacks by colour. */
const TRAY = ["#1f9d55", "#2f6fd6", "#d8262c", "#f3c33b", "#f2f2f2", "#7fb8e6", "#f2f2f2", "#d8262c", "#2f6fd6", "#1f9d55"];
/** How long between the dealer's cards turning up at the end of a round. */
const REVEAL_MS = 650;
/** Insurance: the chips going down, then the dealer lifting the face-down card to look for blackjack. */
const INSURE_MS = 650;
const PEEK_MS = 1300;
/** The dealer taking lost insurance chips away. */
const COLLECT_MS = 700;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CHIP_COLORS: Record<string, string> = { "50": "#7fb8e6", "100": "#f2f2f2", "250": "#f3c33b", "500": "#d8262c", "1000": "#2f6fd6", "2500": "#1f9d55" };
/** A chip's face: "50", "250", "1k", "2.5k". */
const chipText = (amount: number) => (amount >= 1000 ? `${Math.round(amount / 100) / 10}k` : amount % 1 === 0 ? String(amount) : amount.toFixed(1));
const cents = (value: number) => Math.round(value * 100);

/** Blackjack for a Player: the table, the bet, the moves and the last rounds. */
export function BlackjackGame() {
  const { getToken } = useAuth();
  const i18n = useI18n();
  const { t, ts, date } = i18n;
  const toast = useToast();
  const dealKey = useIdempotencyKey();
  const moveKey = useIdempotencyKey();
  const instant = usePrefersReducedMotion();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<BlackjackState | null>(null);
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(0);
  /** The bet before each chip went down, for Undo. */
  const [betHistory, setBetHistory] = useState<number[]>([]);
  const [round, setRound] = useState<BlackjackRoundView | null>(null);
  /** How many of the dealer's cards are face up: at the end of a round they turn over one by one. */
  const [revealed, setRevealed] = useState(1);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  /** Insurance on the table: going down, paid against a blackjack, or taken by the dealer. */
  const [insuranceChips, setInsuranceChips] = useState<{ amount: number; stage: "in" | "won" | "lost" } | null>(null);
  /** The dealer looking at the face-down card, and once they have. */
  const [peek, setPeek] = useState<"peeking" | "peeked" | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  useEffect(() => setSoundOn(slotSound.on), []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<BlackjackState>("/casino/blackjack", token);
    setState(next);
    setBalance(next.balance);
    setRound(next.round);
    setRevealed(next.round?.phase === "DONE" ? next.round.dealer.length : 1);
    setBet((current) => current || Math.min(next.game.chips[2] ?? next.game.chips[0], next.tableMax));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && !busy) setBalance(event.balance);
  });

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 2600);
    return () => clearTimeout(timer);
  }, [hint]);

  // At the end of a round the dealer's cards turn up one at a time, then the result shows.
  const dealerCount = round?.dealer.length ?? 0;
  const over = round?.phase === "DONE";
  useEffect(() => {
    if (!over || revealed >= dealerCount) return;
    const timer = setTimeout(() => {
      setRevealed((count) => count + 1);
      slotSound.cardDeal();
    }, instant ? 0 : REVEAL_MS);
    return () => clearTimeout(timer);
  }, [over, revealed, dealerCount, instant]);
  const settledShown = over && revealed >= dealerCount;

  // The win sounds once the dealer's cards are all up.
  const sounded = useRef<BlackjackRoundView | null>(null);
  useEffect(() => {
    if (!settledShown || !round || sounded.current === round) return;
    sounded.current = round;
    const back = round.payout ?? 0;
    if (back > round.staked) {
      slotSound.win(round.hands.some((hand) => hand.result === "BLACKJACK"));
      slotSound.coins(Math.min(1400, 400 + back * 20));
    } else if (back < round.staked) slotSound.gambleLose();
  }, [settledShown, round]);

  async function send<T>(path: string, body: object, key: ReturnType<typeof useIdempotencyKey>) {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const text = JSON.stringify(body);
    const result = await apiFetch<T>(path, token, { method: "POST", body: text, idempotencyKey: key.keyFor(path, text) });
    key.done();
    return result;
  }

  /** Shows a new round state: cards come in with a sound each; a finished round turns the dealer's cards up one by one. */
  function show(next: BlackjackRoundView, fresh: boolean) {
    const before = fresh ? 0 : (round?.hands.reduce((sum, hand) => sum + hand.cards.length, 0) ?? 0) + 2;
    const after = next.hands.reduce((sum, hand) => sum + hand.cards.length, 0) + 2;
    for (let i = 0; i < Math.max(1, after - before); i++) setTimeout(() => slotSound.cardDeal(), i * 140);
    setRound(next);
    setRevealed(1);
    if (next.phase === "DONE") void refreshRecent();
  }

  /** The last hands, after a round ends; the round itself stays on the table. */
  async function refreshRecent() {
    try {
      const token = await getToken();
      if (!token) return;
      const next = await apiFetch<BlackjackState>("/casino/blackjack", token);
      setState((current) => (current ? { ...current, recent: next.recent } : next));
    } catch {
      // The list catches up on the next round.
    }
  }

  async function dealRound() {
    if (!state || busy) return;
    slotSound.unlock();
    if (bet <= 0) {
      setHint(t("Place your bet"));
      return;
    }
    if (bet > balance) {
      setHint(t("Balance too low"));
      return;
    }
    setBusy(true);
    try {
      const result = await send<BlackjackMoveResult>("/casino/blackjack/deal", { bet }, dealKey);
      setInsuranceChips(null);
      setPeek(null);
      setBalance(result.round.phase === "DONE" ? result.balance - (result.round.payout ?? 0) : result.balance);
      show(result.round, true);
      if (result.round.phase === "DONE") setTimeout(() => setBalance(result.balance), instant ? 0 : REVEAL_MS * result.round.dealer.length);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("That didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function move(action: BlackjackAction) {
    if (!round || busy) return;
    slotSound.unlock();
    setBusy(true);
    const answeringInsurance = action === "insure" || action === "noInsurance";
    const insured = action === "insure" ? round.hands[0].bet / 2 : 0;
    try {
      const request = send<BlackjackMoveResult>("/casino/blackjack/action", { action }, moveKey);
      // Handled below, once the animations are done.
      request.catch(() => undefined);
      if (answeringInsurance && !instant) {
        // The insurance goes down, then the dealer lifts the face-down card to look for blackjack.
        if (insured > 0) {
          setInsuranceChips({ amount: insured, stage: "in" });
          slotSound.chip();
          await wait(INSURE_MS);
        }
        setPeek("peeking");
        slotSound.cardFlip();
        await wait(PEEK_MS);
      }
      const result = await request;
      if (answeringInsurance) {
        setPeek("peeked");
        const dealerCardsNow = result.round.dealer.filter((card): card is string => card !== null);
        const dealerBlackjack = result.round.phase === "DONE" && dealerCardsNow.length === 2 && handTotal(dealerCardsNow).total === 21;
        if (insured > 0) setInsuranceChips({ amount: insured, stage: dealerBlackjack ? "won" : "lost" });
        // Lost insurance goes to the dealer, then off the table.
        if (insured > 0 && !dealerBlackjack) setTimeout(() => setInsuranceChips(null), instant ? 0 : COLLECT_MS);
        if (result.round.phase === "PLAYER") setHint(t("No blackjack. Play on."));
      }
      if (result.round.phase === "DONE") {
        // The pay-out arrives in the balance once the dealer's cards are up.
        setBalance(result.balance - (result.round.payout ?? 0));
        setTimeout(() => setBalance(result.balance), instant ? 0 : REVEAL_MS * result.round.dealer.length);
      } else setBalance(result.balance);
      show(result.round, false);
      // A blackjack found by looking is turned over at once.
      if (answeringInsurance && result.round.phase === "DONE") {
        setRevealed(2);
        slotSound.cardFlip();
      }
    } catch (err) {
      setPeek(null);
      setInsuranceChips(null);
      toast.error(err instanceof Error ? err.message : t("That didn't go through. Try again."));
      load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  /** Changes the bet, if the new amount fits the table limit and the balance; remembers the old one for Undo. */
  function changeBet(next: number) {
    if (!state || busy) return;
    slotSound.unlock();
    if (next > state.tableMax + 1e-9) {
      setHint(t("Table limit {amount}", { amount: formatMoney(state.tableMax) }));
      return;
    }
    if (next > balance + 1e-9) {
      setHint(t("Balance too low"));
      return;
    }
    slotSound.chip();
    if (over) setRound(null);
    setBetHistory((list) => [...list, bet].slice(-30));
    setBet(next);
  }

  const addChip = (value: number) => changeBet((cents(bet) + cents(value)) / 100);
  const doubleBet = () => bet > 0 && changeBet((cents(bet) * 2) / 100);

  function undoBet() {
    if (busy) return;
    slotSound.click();
    if (over) setRound(null);
    if (betHistory.length === 0) {
      setBet(0);
      return;
    }
    setBet(betHistory[betHistory.length - 1]);
    setBetHistory((list) => list.slice(0, -1));
  }

  useGameKeys(rulesOpen);

  if (!state) return <PageLoading label="Loading the Casino" />;
  const inPlay = round !== null && round.phase !== "DONE";
  const betting = !inPlay;
  const can = (action: BlackjackAction) => !busy && (round?.allowed.includes(action) ?? false);

  // The dealer's cards as shown: face-down where not turned up yet; cards drawn after the face-down one appear as they turn up.
  const dealerCards = (round?.dealer ?? []).flatMap((card, index) => {
    if (index < revealed && card) return [card];
    if (index === 1) return [null];
    return [];
  });
  const dealerShownTotal = handTotal(dealerCards.filter((card): card is string => card !== null));

  const message = (() => {
    if (busy && !round) return t("Dealing…");
    if (peek === "peeking") return t("The dealer checks for blackjack…");
    if (hint) return hint;
    if (round?.phase === "INSURANCE") return t("Insurance? It costs {amount}", { amount: formatMoney(round.hands[0].bet / 2) });
    if (round?.phase === "PLAYER") {
      const hand = round.hands[round.active];
      const total = `${hand.soft ? t("Soft") + " " : ""}${hand.total}`;
      return round.hands.length > 1 ? t("Hand {number}: {total}", { number: round.active + 1, total }) : t("Your hand: {total}", { total });
    }
    if (round && !settledShown) return t("Dealer's turn");
    if (round && settledShown) return outcome(round, t);
    return bet > 0 ? t("Tap Deal to play") : t("Place your bet");
  })();
  const won = settledShown && round !== null && (round.payout ?? 0) > round.staked;

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>{t("Blackjack")}</h1>
          <p className="muted report-subtitle">{t("Beat the dealer to 21, played with your balance.")}</p>
          <p className="game-keys-hint">{t("Keys: Space deals, H hits, S stands, D doubles, P splits, Y and N answer insurance.")}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setRulesOpen(true)}>
          {t("Pays and rules")}
        </button>
      </div>

      {state.closed && !inPlay ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <>
          <div className="slot-rotate roulette-rotate" role="status">
            <RotatePhoneIcon />
            <strong>{t("Turn your phone sideways to play")}</strong>
            <span className="muted">{t("{name} plays with the phone held sideways. Turn it and the game opens.", { name: t("Blackjack") })}</span>
          </div>

          <section ref={cabinet} className={`roulette-cabinet blackjack-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label={t("Blackjack")}>
            <header className="slot-marquee roulette-marquee">
              <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
                ‹
              </Link>
              <span className="slot-title">{t("Blackjack")}</span>
              <button
                type="button"
                className="slot-fullscreen blackjack-sound-button"
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
              <button type="button" className="slot-fullscreen roulette-rules-button" onClick={() => setRulesOpen(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
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

            <div className="blackjack-table">
              <div className="blackjack-felt">
                <div className="blackjack-tray" aria-hidden="true">
                  {TRAY.map((color, index) => (
                    <span key={index} style={{ "--chip": color } as CSSProperties} />
                  ))}
                </div>
                <div className="blackjack-discard" aria-hidden="true" />
                <div className="blackjack-shoe" aria-hidden="true">
                  <span />
                </div>

                <div className="blackjack-dealer" aria-label={t("Dealer")}>
                  <div className="blackjack-cards">
                    {round
                      ? dealerCards.map((card, index) => (
                          <PlayingCard
                            key={`d${index}-${card ?? "back"}`}
                            card={card}
                            order={index * 2 + 1}
                            fresh={!over && round.hands[0].cards.length <= 2}
                            flip={index === 1 && card !== null}
                            peek={index === 1 && card === null ? peek : null}
                          />
                        ))
                      : null}
                  </div>
                  {round ? <span className={`blackjack-total${dealerShownTotal.total > 21 ? " is-bust" : ""}`}>{dealerShownTotal.total}</span> : null}
                </div>

                <svg className="blackjack-print" viewBox="0 0 600 132" aria-hidden="true">
                  <defs>
                    <path id="blackjack-arc-main" d="M 60 22 Q 300 120 540 22" />
                    <path id="blackjack-arc-sub" d="M 40 58 Q 300 158 560 58" />
                  </defs>
                  <path className="blackjack-print-line" d="M 20 6 Q 300 118 580 6" />
                  <text className="blackjack-print-main">
                    <textPath href="#blackjack-arc-main" startOffset="50%" textAnchor="middle">
                      {t("Blackjack pays 3 to 2")}
                    </textPath>
                  </text>
                  <text className="blackjack-print-sub">
                    <textPath href="#blackjack-arc-sub" startOffset="50%" textAnchor="middle">
                      {t("Dealer stands on soft 17 · Insurance pays 2 to 1")}
                    </textPath>
                  </text>
                </svg>

                <div className="blackjack-player">
                  {insuranceChips ? (
                    <div className={`blackjack-insurance is-${insuranceChips.stage}`} aria-label={t("Insurance")}>
                      <ChipStack amount={insuranceChips.amount} />
                      <span className="blackjack-insurance-label">{t("Insurance")}</span>
                    </div>
                  ) : null}
                  {round ? (
                    round.hands.map((hand, index) => {
                      const shownResult = settledShown ? hand.result : null;
                      return (
                        <div
                          key={index}
                          className={`blackjack-hand${round.phase === "PLAYER" && round.hands.length > 1 && index === round.active ? " is-active" : ""}${shownResult ? ` is-${shownResult.toLowerCase()}` : ""}`}
                        >
                          {shownResult ? <span className={`blackjack-ribbon is-${shownResult.toLowerCase()}`}>{ribbonText(shownResult, hand.payout - hand.bet, t)}</span> : null}
                          <div className="blackjack-cards">
                            {hand.cards.map((card, cardIndex) => (
                              <PlayingCard key={`${index}-${cardIndex}-${card}`} card={card} order={cardIndex * 2} fresh={hand.cards.length <= 2 && round.hands.length === 1} />
                            ))}
                          </div>
                          <div className="blackjack-hand-info">
                            <span className={`blackjack-total${hand.blackjack ? " is-blackjack" : hand.total > 21 ? " is-bust" : ""}`}>{hand.blackjack ? t("BJ") : hand.soft && !hand.done ? `${hand.total - 10}/${hand.total}` : hand.total}</span>
                            <ChipStack amount={hand.bet} />
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className={`blackjack-spot${bet > 0 ? " has-bet" : ""}`}>
                      <span className="blackjack-spot-label">{t("Bet")}</span>
                      {bet > 0 ? <ChipStack amount={bet} large /> : null}
                    </div>
                  )}
                </div>

                <div className="blackjack-console">
                  {betting ? (
                    <div className="blackjack-betting">
                      <button type="button" className="blackjack-side-button" disabled={busy || bet === 0} onClick={undoBet} aria-label={t("Undo")}>
                        <span aria-hidden="true">↺</span>
                        <small>{t("Undo")}</small>
                      </button>
                      <div className="blackjack-chip-rail" role="group" aria-label={t("Chip")}>
                        {state.game.chips.map((value, index) => (
                          <button
                            key={value}
                            type="button"
                            className="casino-chip"
                            style={{ "--chip": CHIP_COLORS[String(value)], "--mark": value === 100 ? "#2f6fd6" : "#fff", "--ink": value === 100 ? "#1b1b1b" : "#fff", "--arc": Math.abs(index - (state.game.chips.length - 1) / 2) } as CSSProperties}
                            disabled={busy}
                            onClick={() => addChip(value)}
                            aria-label={t("Add {amount}", { amount: formatMoney(value) })}
                          >
                            <span>{chipText(value)}</span>
                          </button>
                        ))}
                      </div>
                      <button type="button" className="blackjack-side-button is-double" disabled={busy || bet === 0} onClick={doubleBet} aria-label={t("Double the bet")}>
                        <span aria-hidden="true">2×</span>
                        <small>{t("Double")}</small>
                      </button>
                      <button type="button" className="blackjack-deal" data-key="Space" disabled={busy || bet === 0 || Boolean(state.closed)} onClick={() => void dealRound()}>
                        {t("Deal")}
                      </button>
                    </div>
                  ) : round.phase === "INSURANCE" ? (
                    <div className="blackjack-moves is-insurance">
                      <MoveButton kind="double" icon="½" label={t("Insurance")} keys="KeyY" disabled={!can("insure")} onClick={() => void move("insure")} />
                      <MoveButton kind="clear" icon="✕" label={t("No insurance")} keys="KeyN" disabled={!can("noInsurance")} onClick={() => void move("noInsurance")} />
                    </div>
                  ) : (
                    <div className="blackjack-moves">
                      <MoveButton kind="double" icon="2×" label={t("Double")} keys="KeyD" disabled={!can("double")} onClick={() => void move("double")} />
                      <MoveButton kind="hit" icon="+" label={t("Hit")} keys="KeyH" disabled={!can("hit")} onClick={() => void move("hit")} />
                      <MoveButton kind="stand" icon="−" label={t("Stand")} keys="KeyS" disabled={!can("stand")} onClick={() => void move("stand")} />
                      <MoveButton kind="split" icon="◀▶" label={t("Split")} keys="KeyP" disabled={!can("split")} onClick={() => void move("split")} />
                      <span className="blackjack-moves-total">{round.hands[round.active].total}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="blackjack-info">
              <span>
                <small>{t("Balance")}</small>
                <strong>{formatMoney(balance)}</strong>
              </span>
              <span className={`blackjack-info-message${won ? " is-win" : ""}`} aria-live="polite">
                {message}
              </span>
              <span className="is-right">
                <small>{t("Total bet")}</small>
                <strong>{formatMoney(inPlay ? round.staked : bet)}</strong>
              </span>
            </div>
            {rulesOpen && fullScreen !== "off" ? <BlackjackRules state={state} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
          </section>
        </>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last hands")}
          <HelpTip text="Your newest blackjack rounds. They're also in My money, as one Blackjack line for each day." />
        </h2>
        {state.recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No hands yet.")}</p>
        ) : (
          <div className="report-list">
            {state.recent.map((past) => (
              <div className="report-list-row" key={past.id}>
                <div>
                  <strong>
                    {past.hands.map((hand) => (hand.blackjack ? t("Blackjack") : String(hand.total))).join(" / ")} {t("against {total}", { total: past.dealerTotal })}
                  </strong>
                  <span className="muted">
                    {date(past.createdAt, TIME)} · {t("{amount} staked", { amount: formatMoney(past.staked) })}
                  </span>
                </div>
                <strong className={past.win > past.staked ? "money-amount is-in" : past.win === past.staked ? "muted" : undefined}>
                  {past.win > past.staked ? `+${formatMoney(past.win - past.staked)}` : past.win === past.staked ? t("Push") : `−${formatMoney(past.staked - past.win)}`}
                </strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen && fullScreen === "off" ? <BlackjackRules state={state} onClose={() => setRulesOpen(false)} i18n={i18n} /> : null}
    </div>
  );
}

function resultLabel(result: NonNullable<BlackjackRoundView["hands"][number]["result"]>, t: I18n["t"]) {
  return { BLACKJACK: t("Blackjack!"), WIN: t("Win"), PUSH: t("Push"), LOSE: t("Lose"), BUST: t("Bust") }[result];
}

/** What a finished round comes to, in a few words. */
function outcome(round: BlackjackRoundView, t: I18n["t"]): string {
  const back = round.payout ?? 0;
  if (round.hands.some((hand) => hand.result === "BLACKJACK")) return t("Blackjack! You win {amount}", { amount: formatMoney(back) });
  if (back > round.staked) return t("You win {amount}", { amount: formatMoney(back) });
  if (back === round.staked) return t("Push: your bet is back");
  if (round.insurancePayout > 0) return t("Insurance pays {amount}", { amount: formatMoney(round.insurancePayout) });
  if (round.hands.every((hand) => hand.result === "BUST")) return t("Bust");
  return t("Dealer wins");
}

/** The figures on the face cards: chess pieces read as king, queen and knight (jack). Text, not emoji, on every phone. */
const FIGURES: Record<string, string> = { K: "♚", Q: "♛", J: "♞" };

/** A playing card, drawn in markup: rank and suit in the corners, the suit large in the middle. Null is a card face down; `flip` turns it over where it lies (the dealer's face-down card) instead of dealing it in. */
function PlayingCard({ card, order, fresh, flip = false, peek = null }: { card: string | null; order: number; fresh: boolean; flip?: boolean; peek?: "peeking" | "peeked" | null }) {
  // The first four cards come out one after another; later ones straight away.
  const style = { animationDelay: fresh ? `${order * 140}ms` : "0ms" } as CSSProperties;
  if (!card) return <span className={`playing-card is-back${peek ? ` is-${peek}` : ""}`} style={style} aria-label="?" />;
  const rank = rankLabel(card);
  const suit = SUIT_SYMBOLS[card[1]];
  const face = "JQK".includes(card[0]);
  return (
    <span className={`playing-card${isRedSuit(card) ? " is-red" : ""}${flip ? " is-flipped" : ""}`} style={style} aria-label={`${rank}${suit}`}>
      <span className="playing-card-corner">
        {rank}
        <small>{suit}</small>
      </span>
      {face ? (
        <span className="playing-card-face">
          <span className="playing-card-figure">{FIGURES[card[0]]}</span>
          <span className="playing-card-face-rank">{rank}</span>
          <span className="playing-card-face-suit">{suit}</span>
        </span>
      ) : (
        <span className={`playing-card-pip${card[0] === "A" ? " is-ace" : ""}`}>{suit}</span>
      )}
      <span className="playing-card-corner is-bottom">
        {rank}
        <small>{suit}</small>
      </span>
    </span>
  );
}

/** The chips that make up an amount, biggest first: how a stack of them looks. */
function chipsFor(amount: number): number[] {
  const chips: number[] = [];
  let left = cents(amount);
  for (const chip of [2500, 1000, 500, 250, 100, 50]) {
    while (left >= cents(chip) && chips.length < 12) {
      chips.push(chip);
      left -= cents(chip);
    }
  }
  return chips.reverse();
}

/** A bet as a stack of real chips, the amount underneath. */
function ChipStack({ amount, large = false }: { amount: number; large?: boolean }) {
  const chips = chipsFor(amount).slice(-8);
  return (
    <span className={`blackjack-stack${large ? " is-large" : ""}`}>
      <span className="blackjack-stack-chips" style={{ "--count": chips.length } as CSSProperties}>
        {chips.map((chip, index) => (
          <span key={index} className="blackjack-stack-chip" style={{ "--chip": CHIP_COLORS[String(chip)], "--at": index } as CSSProperties}>
            {index === chips.length - 1 ? <span className="blackjack-stack-top">{chipText(chip)}</span> : null}
          </span>
        ))}
      </span>
      <span className="blackjack-stack-amount">{formatMoney(amount)}</span>
    </span>
  );
}

/** A big table button: a coloured tile with an icon, its name underneath. */
function MoveButton({ kind, icon, label, keys, disabled, onClick }: { kind: "hit" | "stand" | "double" | "split" | "clear"; icon: string; label: string; keys: string; disabled: boolean; onClick(): void }) {
  return (
    <button type="button" className={`blackjack-move is-${kind}`} data-key={keys} disabled={disabled} onClick={onClick}>
      <span className="blackjack-move-tile" aria-hidden="true">
        {icon}
      </span>
      <span className="blackjack-move-label">{label}</span>
    </button>
  );
}

/** What a hand's ribbon says when the round is over: the result, and what it won. */
function ribbonText(result: NonNullable<BlackjackRoundView["hands"][number]["result"]>, net: number, t: I18n["t"]) {
  if (result === "BLACKJACK") return `${t("Blackjack!")} +${formatMoney(net)}`;
  if (result === "WIN") return `${t("Win")} +${formatMoney(net)}`;
  return resultLabel(result, t);
}

function BlackjackRules({ state, onClose, i18n }: { state: BlackjackState; onClose: () => void; i18n: I18n }) {
  const { t } = i18n;
  const rows: Array<[string, string]> = [
    [t("Blackjack"), t("An ace and a ten or face card as your first two cards. Pays 3 to 2.")],
    [t("Win"), t("Closer to 21 than the dealer without going over, or the dealer goes over. Pays 1 to 1.")],
    [t("Push"), t("The same total as the dealer. Your bet comes back.")],
    [t("Hit or stand"), t("Hit takes another card; stand keeps what you have. Over 21 is bust and loses.")],
    [t("Double"), t("Double your bet on your first two cards and take exactly one more card. Once a round.")],
    [t("Split"), t("Two cards of the same rank, like two kings (not a king and a queen), become two hands, each with its own bet. Once a round.")],
    [t("Insurance"), t("When the dealer shows an ace: half your bet that the dealer has blackjack. Pays 2 to 1, settled when the dealer's card is turned over.")],
  ];
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="blackjack-rules-title">
        <div className="modal-header">
          <h2 id="blackjack-rules-title">{t("Pays and rules")}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>×</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Get closer to 21 than the dealer. Cards 2 to 10 count their number, faces 10, an ace 1 or 11. The dealer draws to 17 and stands on every 17, soft 17 included. With an ace showing, the dealer offers insurance, then looks at the face-down card: a blackjack is turned over at once and ends the round. Under any other card, the dealer's second card stays face down until you've played: a dealer's blackjack beats every hand but a blackjack, doubles and splits included. Six decks, shuffled for every round.")}
        </p>
        <div className="report-list">
          {rows.map(([name, how]) => (
            <div className="report-list-row" key={name}>
              <div>
                <strong>{name}</strong>
                <span className="muted">{how}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {t("Bets from {min} up to {limit} a hand: your max stake, if you have one. Doubling and splitting add to it. A hand left for an hour is stood for you.", {
            min: formatMoney(state.game.chips[0]),
            limit: formatMoney(state.tableMax),
          })}
        </p>
      </section>
    </div>
  );
}
