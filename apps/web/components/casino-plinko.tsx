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
import { apiFetch, newIdempotencyKey, type PlinkoBall, type PlinkoDropResult, type PlinkoRisk, type PlinkoRows, type PlinkoState } from "../lib/api";
import { formatMoney } from "../lib/format";
import { msg } from "../lib/i18n/core";

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** Balls that can be falling at once. */
const MAX_IN_FLIGHT = 12;
/** How long the ball takes from one row of pegs to the next, in milliseconds; quicker when the phone asks for less motion. */
const STEP_MS = 105;
const STEP_MS_REDUCED = 35;
/** Time between balls on autoplay. */
const AUTO_MS = 380;

const RISK_NAMES: Record<PlinkoRisk, string> = { LOW: msg("Low"), MEDIUM: msg("Medium"), HIGH: msg("High") };

/** A bucket's colour: gold in the middle, red at the edges. */
const bucketHue = (bucket: number, rows: number) => 46 - (Math.abs(bucket - rows / 2) / (rows / 2)) * 56;
const times = (multiplier: number) => (multiplier >= 100 ? String(multiplier) : `${multiplier}×`);

/** The board's layout for a canvas `width` wide: peg spacing, rows, and where everything sits. */
function layout(width: number, rows: number) {
  const gap = width / (rows + 2);
  const rise = gap * 0.9;
  const top = rise;
  return {
    gap,
    rise,
    top,
    height: top + rows * rise,
    pegRadius: Math.max(2, gap * 0.1),
    ballRadius: Math.max(3.5, gap * 0.23),
    /** Where the ball sits on row `row` after `rights` bounces to the right. Row `rows` is the bucket's mouth. */
    at(row: number, rights: number) {
      return { x: width / 2 + (rights - row / 2) * gap, y: top + row * rise - this.pegRadius - this.ballRadius };
    },
  };
}

type Falling = { id: number; path: number[]; start: number; step: number; rows: number; landed: boolean; onLand: () => void; onPeg: (row: number) => void; pegged: number };

/** Plinko for a Player: pick the rows, the risk and the stake, and drop balls. */
export function PlinkoGame() {
  const { getToken } = useAuth();
  const { t, ts, date } = useI18n();
  const toast = useToast();
  const { ref: cabinet, mode: fullScreen, toggle: toggleFullScreen } = useFullScreen<HTMLElement>();

  const [state, setState] = useState<PlinkoState | null>(null);
  const [rows, setRows] = useState<PlinkoRows>(16);
  const [risk, setRisk] = useState<PlinkoRisk>("MEDIUM");
  const [bet, setBet] = useState(0);
  const [recent, setRecent] = useState<PlinkoBall[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [auto, setAuto] = useState(false);
  const [lastWin, setLastWin] = useState<PlinkoBall | null>(null);
  /** Buckets that just caught a ball, with a count so the same bucket lights again on the next one. */
  const [lit, setLit] = useState<Record<number, number>>({});

  // Money in play. The balance shown is the one after the last ball that landed, less the stakes of balls still falling,
  // so a win shows when its ball lands, not when the server answers.
  const [landed, setLanded] = useState(0);
  const [inPlay, setInPlay] = useState({ balls: 0, stakes: 0 });
  const landedOrder = useRef(0);
  const answered = useRef(0);
  const balls = useRef<Falling[]>([]);
  const pegFlash = useRef(new Map<string, number>());
  const canvas = useRef<HTMLCanvasElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const width = useRef(0);
  const reducedMotion = useRef(false);
  const ballId = useRef(0);

  useEffect(() => setSoundOn(slotSound.on), []);
  useEffect(() => {
    reducedMotion.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) throw new Error(t("You're not signed in"));
    const next = await apiFetch<PlinkoState>("/casino/plinko", token);
    setState(next);
    setLanded(next.balance);
    setRecent(next.recent);
    setBet((current) => current || Math.min(next.game.bets[2] ?? next.game.bets[0], next.tableMax));
  }, [getToken, t]);

  useEffect(() => {
    load().catch((err: Error) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtime((event) => {
    if (event.type === "balance.changed" && balls.current.length === 0 && inPlay.balls === 0) setLanded(event.balance);
  });

  const balance = Math.round((landed - inPlay.stakes) * 100) / 100;

  /** Draws the pegs and every falling ball, and keeps going while anything moves. */
  const draw = useCallback(() => {
    frame.current = null;
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx || width.current <= 0) return;
    const geometry = layout(width.current, rows);
    const ratio = window.devicePixelRatio || 1;
    const now = performance.now();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width.current, geometry.height);

    for (let row = 0; row < rows; row += 1) {
      for (let peg = 0; peg < row + 3; peg += 1) {
        const x = width.current / 2 + (peg - (row + 2) / 2) * geometry.gap;
        const y = geometry.top + row * geometry.rise;
        const flash = pegFlash.current.get(`${row}:${peg}`);
        const glow = flash === undefined ? 0 : Math.max(0, 1 - (now - flash) / 260);
        if (glow > 0) {
          ctx.beginPath();
          ctx.fillStyle = `rgba(255, 214, 102, ${0.45 * glow})`;
          ctx.arc(x, y, geometry.pegRadius * (2.2 + glow), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.fillStyle = glow > 0 ? "#fff3c4" : "#dfe7f2";
        ctx.arc(x, y, geometry.pegRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const ball of balls.current) {
      const elapsed = now - ball.start;
      // The first step drops the ball from above the board onto the top peg; then one step per row.
      const stepIndex = Math.floor(elapsed / ball.step);
      const u = Math.min(1, (elapsed - stepIndex * ball.step) / ball.step);
      let from: { x: number; y: number };
      let to: { x: number; y: number };
      let hop = 0;
      if (stepIndex === 0) {
        to = geometry.at(0, 0);
        from = { x: to.x, y: -geometry.ballRadius };
      } else {
        const row = Math.min(stepIndex - 1, ball.path.length - 1);
        const rights = ball.path.slice(0, row).reduce((sum, side) => sum + side, 0);
        from = geometry.at(row, rights);
        to = geometry.at(row + 1, rights + ball.path[row]);
        if (row + 1 === ball.path.length) to = { x: to.x, y: geometry.height + geometry.ballRadius };
        hop = geometry.rise * 0.32;
        // The peg the ball is bouncing off lights up and ticks, once.
        if (ball.pegged < row + 1) {
          ball.pegged = row + 1;
          pegFlash.current.set(`${row}:${rights + 1}`, now);
          ball.onPeg(row);
        }
      }
      const done = stepIndex > ball.path.length;
      const x = done ? to.x : from.x + (to.x - from.x) * u;
      const y = done ? to.y : from.y + (to.y - from.y) * u * u - hop * 4 * u * (1 - u);
      if (done && !ball.landed) {
        ball.landed = true;
        ball.onLand();
        continue;
      }
      const gradient = ctx.createRadialGradient(x - geometry.ballRadius * 0.35, y - geometry.ballRadius * 0.4, geometry.ballRadius * 0.15, x, y, geometry.ballRadius);
      gradient.addColorStop(0, "#fff7d6");
      gradient.addColorStop(0.5, "#ff5d8f");
      gradient.addColorStop(1, "#b0174a");
      ctx.beginPath();
      ctx.fillStyle = gradient;
      ctx.arc(x, y, geometry.ballRadius, 0, Math.PI * 2);
      ctx.fill();
    }
    balls.current = balls.current.filter((ball) => !ball.landed);
    pegFlash.current.forEach((at, key) => {
      if (now - at > 300) pegFlash.current.delete(key);
    });

    if (balls.current.length > 0 || pegFlash.current.size > 0) frame.current = window.requestAnimationFrame(draw);
  }, [rows]);

  const redraw = useCallback(() => {
    if (frame.current === null) frame.current = window.requestAnimationFrame(draw);
  }, [draw]);

  // The canvas follows the board's width, drawn sharp on any screen.
  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const resize = () => {
      const next = element.clientWidth;
      if (!next || !canvas.current) return;
      width.current = next;
      const ratio = window.devicePixelRatio || 1;
      const height = layout(next, rows).height;
      canvas.current.width = Math.round(next * ratio);
      canvas.current.height = Math.round(height * ratio);
      canvas.current.style.height = `${height}px`;
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
      draw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rows, draw, state]);

  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  const falling = inPlay.balls > 0;
  const canDrop = !!state && !state.closed && bet > 0 && bet <= state.tableMax && bet <= balance + 1e-9 && inPlay.balls < MAX_IN_FLIGHT;

  const drop = useCallback(async () => {
    if (!state || !canDrop) return false;
    slotSound.unlock();
    const stake = bet;
    setInPlay((current) => ({ balls: current.balls + 1, stakes: current.stakes + stake }));
    const release = () => setInPlay((current) => ({ balls: current.balls - 1, stakes: Math.round((current.stakes - stake) * 100) / 100 }));
    let result: PlinkoDropResult;
    try {
      const token = await getToken();
      if (!token) throw new Error(t("You're not signed in"));
      result = await apiFetch<PlinkoDropResult>("/casino/plinko/drop", token, { method: "POST", body: JSON.stringify({ bet: stake, rows, risk }), idempotencyKey: newIdempotencyKey() });
    } catch (err) {
      release();
      toast.error(err instanceof Error ? ts(err.message) : t("That didn't go through. Try again."));
      return false;
    }
    answered.current += 1;
    const order = answered.current;
    const ball = result.round;
    ballId.current += 1;
    balls.current.push({
      id: ballId.current,
      path: ball.path,
      rows: ball.rows,
      start: performance.now(),
      step: reducedMotion.current ? STEP_MS_REDUCED : STEP_MS,
      landed: false,
      pegged: 0,
      onPeg: (row) => slotSound.peg(row, ball.rows),
      onLand: () => {
        release();
        if (order > landedOrder.current) {
          landedOrder.current = order;
          setLanded(result.balance);
        }
        slotSound.bucket(ball.multiplier);
        setLit((current) => ({ ...current, [ball.bucket]: (current[ball.bucket] ?? 0) + 1 }));
        setRecent((list) => [ball, ...list].slice(0, 10));
        if (ball.win > ball.bet) setLastWin(ball);
      },
    });
    redraw();
    return true;
  }, [state, canDrop, bet, rows, risk, getToken, t, toast, ts, redraw]);

  // Autoplay: a ball every AUTO_MS until it's switched off or a ball can't be dropped.
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const canDropRef = useRef(canDrop);
  canDropRef.current = canDrop;
  const inPlayRef = useRef(0);
  inPlayRef.current = inPlay.balls;
  useEffect(() => {
    if (!auto) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped) return;
      if (!canDropRef.current) {
        // Wait while balls are still falling (their wins may yet cover the next); stop once none are and it still can't drop.
        if (inPlayRef.current === 0) setAuto(false);
        return;
      }
      void dropRef.current().then((ok) => {
        if (!ok) setAuto(false);
      });
    }, AUTO_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [auto]);

  // On a computer, Space drops a ball (held down, it drops one, not a stream). Not while typing, with the rules open, or on autoplay.
  const autoRef = useRef(auto);
  autoRef.current = auto;
  const rulesOpenRef = useRef(rulesOpen);
  rulesOpenRef.current = rulesOpen;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (rulesOpenRef.current) return;
      // Space would otherwise scroll the page, or press whichever button has focus as well.
      event.preventDefault();
      if (event.type !== "keydown" || event.repeat || autoRef.current) return;
      void dropRef.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  if (!state) return <PageLoading label="Loading the Casino" />;

  const pays = state.game.pays[rows][risk];
  const rate = state.game.payoutRates[rows][risk];
  const buckets = rows + 1;

  return (
    <div className="stack casino-page">
      <Link className="casino-back" href="/dashboard/casino">
        ‹ {t("Casino")}
      </Link>
      <div className="page-title-row">
        <div>
          <h1 style={{ margin: 0 }}>Plinko</h1>
          <p className="muted report-subtitle">{t("Drop a ball through the pegs and see where it lands. Played with your balance.")}</p>
        </div>
        <button type="button" className="secondary" onClick={() => setRulesOpen(true)}>
          {t("Pays and rules")}
        </button>
      </div>

      {state.closed ? (
        <div className="card">
          <p style={{ margin: 0 }}>{ts(state.closed)}</p>
        </div>
      ) : (
        <section ref={cabinet} className={`plinko-cabinet${fullScreen !== "off" ? " is-full" : ""}`} aria-label="Plinko">
          <header className="slot-marquee plinko-marquee">
            <Link className="slot-exit" href="/dashboard/casino" aria-label={t("Leave the game")}>
              ‹
            </Link>
            <span className="slot-title">Plinko</span>
            <button
              type="button"
              className="slot-fullscreen plinko-sound"
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
            <button type="button" className="slot-fullscreen plinko-rules" onClick={() => setRulesOpen(true)} aria-label={t("Pays and rules")} title={t("Pays and rules")}>
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

          <div className="plinko-body">
            <div className="plinko-stage">
              <div className="mines-readout" aria-live="polite">
                <span>
                  <small>{t("Balance")}</small>
                  <strong>{formatMoney(balance)}</strong>
                </span>
                <span>
                  <small>{t("Stake")}</small>
                  <strong>{formatMoney(bet)}</strong>
                </span>
                <span>
                  <small>{t("Last win")}</small>
                  <strong>{lastWin ? `${formatMoney(lastWin.win)}` : "—"}</strong>
                </span>
              </div>
              <div className="plinko-history" aria-label={t("Your last balls")}>
                {recent.slice(0, 6).map((ball) => (
                  <span key={ball.id} className="plinko-chip" style={{ "--hue": bucketHue(ball.bucket, ball.rows) } as CSSProperties}>
                    {times(ball.multiplier)}
                  </span>
                ))}
              </div>
              <div className="plinko-board" ref={board}>
                <canvas ref={canvas} className="plinko-canvas" aria-hidden="true" />
                <div className="plinko-buckets" style={{ gridTemplateColumns: `repeat(${buckets}, 1fr)`, paddingInline: `${50 / (rows + 2)}%` }}>
                  {pays.map((multiplier, bucket) => (
                    <span
                      key={`${bucket}-${lit[bucket] ?? 0}`}
                      className={`plinko-bucket${lit[bucket] ? " is-hit" : ""}${rows === 16 ? " is-small" : ""}`}
                      style={{ "--hue": bucketHue(bucket, rows) } as CSSProperties}
                      title={`${multiplier}×`}
                    >
                      {times(multiplier)}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mines-controls plinko-controls">
              <div className="plinko-settings">
                <small className="plinko-label" aria-hidden="true">
                  {t("Risk")}
                </small>
                <div className="mines-picks" role="radiogroup" aria-label={t("Risk")}>
                  {state.game.risks.map((value) => (
                    <button key={value} type="button" className={`mines-pick${risk === value ? " is-on" : ""}`} aria-pressed={risk === value} disabled={falling || auto} onClick={() => setRisk(value)}>
                      {t(RISK_NAMES[value])}
                    </button>
                  ))}
                </div>
                <small className="plinko-label" aria-hidden="true">
                  {t("Rows")}
                </small>
                <div className="mines-picks" role="radiogroup" aria-label={t("Rows")}>
                  {state.game.rows.map((value) => (
                    <button key={value} type="button" className={`mines-pick${rows === value ? " is-on" : ""}`} aria-pressed={rows === value} aria-label={t("{count} rows", { count: value })} disabled={falling || auto} onClick={() => setRows(value)}>
                      <span className="plinko-rows-word">{t("{count} rows", { count: value })}</span>
                      <span className="plinko-rows-number" aria-hidden="true">
                        {value}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <small className="plinko-label" aria-hidden="true">
                {t("Stake")}
              </small>
              <div className="mines-picks" role="radiogroup" aria-label={t("Stake")}>
                {state.game.bets.map((value) => (
                  <button key={value} type="button" className={`mines-pick${bet === value ? " is-on" : ""}`} aria-pressed={bet === value} disabled={auto || value > state.tableMax} onClick={() => setBet(value)}>
                    {formatMoney(value)}
                  </button>
                ))}
              </div>
              <div className="plinko-actions">
                <button type="button" className="mines-go" disabled={auto || !canDrop} onClick={() => void drop()}>
                  {t("Drop a ball {amount}", { amount: formatMoney(bet) })}
                </button>
                <button type="button" className={`mines-pick plinko-auto${auto ? " is-on" : ""}`} aria-pressed={auto} disabled={!auto && !canDrop} onClick={() => setAuto(!auto)}>
                  {auto ? t("Stop") : t("Auto")}
                </button>
              </div>
              <p className="plinko-hint">{t("Press Space to drop a ball.")}</p>
            </div>
          </div>
        </section>
      )}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>
          {t("Your last balls")}
          <HelpTip text="Your newest Plinko balls. They're also in My money, as one Plinko line for each day." />
        </h2>
        {recent.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>{t("No balls yet.")}</p>
        ) : (
          <div className="report-list">
            {recent.map((ball) => (
              <div className="report-list-row" key={ball.id}>
                <div>
                  <strong>{times(ball.multiplier)}</strong>
                  <span className="muted">
                    {date(ball.createdAt, TIME)} · {t("{count} rows", { count: ball.rows })} · {t(RISK_NAMES[ball.risk])} · {t("{amount} stake", { amount: formatMoney(ball.bet) })}
                  </span>
                </div>
                <strong className={ball.win < ball.bet ? "is-bad" : undefined}>{formatMoney(ball.win)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      {rulesOpen ? (
        <div className="modal-backdrop" onClick={() => setRulesOpen(false)}>
          <section className="modal card casino-rules" role="dialog" aria-modal="true" aria-labelledby="plinko-rules-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2 id="plinko-rules-title">{t("Pays and rules")}</h2>
              <button type="button" className="modal-close secondary" onClick={() => setRulesOpen(false)} aria-label={t("Close")}>
                ×
              </button>
            </div>
            <p>
              {t("The ball falls through the rows of pegs. At every peg it goes left or right, each just as likely, and lands in a bucket at the bottom. Each bucket pays the stake times its number: the middle ones are hit most and pay least, the edges are rare and pay most.")}
            </p>
            <p>
              {t("More rows and more risk make the edges pay more and the middle less. Whatever you pick, a ball pays back about {rate}% of its stake on average. A ball costs {min} to {max}, and never more than your max stake. Every ball is decided on our server.", {
                rate: state.game.payoutRate,
                min: formatMoney(state.game.bets[0]),
                max: formatMoney(state.game.bets[state.game.bets.length - 1]),
              })}
            </p>
            <h3 style={{ margin: "0.5rem 0 0.25rem" }}>{t("{count} rows, {risk} risk: {rate}% back", { count: rows, risk: t(RISK_NAMES[risk]).toLowerCase(), rate })}</h3>
            <div className="plinko-paytable">
              {pays.slice(0, rows / 2 + 1).map((multiplier, bucket) => (
                <span key={bucket}>
                  <strong style={{ "--hue": bucketHue(bucket, rows) } as CSSProperties}>{multiplier}×</strong>
                  <small>{chanceText(bucket, rows)}</small>
                </span>
              ))}
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {t("From the edge to the middle; the other side is the same. Under each, how often a ball lands in that bucket or its twin.")}
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** How often a ball lands in `bucket` or the one mirroring it, as "1 in N" or a percentage. */
function chanceText(bucket: number, rows: number): string {
  let ways = 1;
  for (let k = 0; k < bucket; k += 1) ways = (ways * (rows - k)) / (k + 1);
  const chance = (bucket === rows / 2 ? ways : ways * 2) / 2 ** rows;
  if (chance >= 0.01) return `${(chance * 100).toFixed(chance >= 0.1 ? 0 : 1)}%`;
  return `1 / ${Math.round(1 / chance).toLocaleString()}`;
}
