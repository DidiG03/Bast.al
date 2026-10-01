"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { colorOf, label } from "../lib/roulette";
import { slotSound } from "./slot-sounds";

/**
 * The roulette wheel, drawn on a canvas as if seen from a player's seat: a
 * wooden bowl with a ball track, the turning wheel with its pockets and
 * numbers, a gold turret, and the ball. It only animates: the server picks
 * the number, and `spin` is told where the wheel stops. The ball runs round
 * the track against the wheel, slows, drops, bounces across the frets and
 * settles in that pocket, then turns with the wheel.
 */
export type RouletteWheelHandle = {
  /** Spins the ball into the pocket at `stop` (an index into the wheel). Resolves when it has settled. */
  spin(stop: number): Promise<void>;
};

type Props = {
  /** The pockets in order round the wheel. */
  wheel: number[];
  /** Where the ball rests before the first spin (an index into the wheel); null for no ball. */
  resting: number | null;
  /** Settle straight away instead of spinning (reduced motion). */
  instant: boolean;
};

/* The drawing's own units; the canvas is scaled to fit its box. */
const W = 500;
const H = 330;
const CX = W / 2;
const CY = 172;
/** The bowl's outer radius, and how squashed the circle looks from the seat. */
const R = 232;
const TILT = 0.56;
/** How deep the bowl's side looks below its rim. */
const DEPTH = 20;

/* Radii, as parts of R: the wood rim, the ball track, the numbers, the pockets and the cone. */
const TRACK_OUT = 0.86;
const TRACK_IN = 0.73;
const NUMBERS_OUT = 0.7;
const NUMBERS_IN = 0.6;
const POCKETS_IN = 0.49;
const BALL_TRACK = 0.8;
const BALL_POCKET = 0.545;
const BALL_SIZE = 0.03;

/** How long a spin takes, and when the ball leaves the track. */
const SPIN_MS = 7200;
const DROP_AT = 0.58;
/** Turns the ball makes against the wheel. */
const TURNS = 7;
/** The wheel's own speed, in radians a second: idle, and just after a spin starts. */
const IDLE_SPEED = 0.32;
const SPIN_SPEED = 1.1;

const POCKET_RED = "#c3161c";
const POCKET_BLACK = "#16171b";
const POCKET_GREEN = "#0d8a3a";

function easeOutCubic(u: number) {
  return 1 - (1 - u) ** 3;
}

/** The wooden bowl and its ball track, seen from straight above. */
function drawBowl(scale: number): HTMLCanvasElement {
  const size = Math.ceil(2 * R * scale);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.translate(R, R);

  // The rim: polished wood, darker at its edges.
  const rim = ctx.createRadialGradient(0, 0, R * TRACK_OUT, 0, 0, R);
  rim.addColorStop(0, "#3a1a0b");
  rim.addColorStop(0.35, "#7b3c17");
  rim.addColorStop(0.7, "#9a5222");
  rim.addColorStop(1, "#4a210c");
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = rim;
  ctx.fill();
  // Grain: faint rings.
  ctx.globalAlpha = 0.14;
  for (let r = R * TRACK_OUT + 3; r < R - 2; r += 3.2) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = r % 2 > 1 ? "#2a1206" : "#c77d44";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // A gold line round the top of the rim.
  ctx.beginPath();
  ctx.arc(0, 0, R - 2, 0, Math.PI * 2);
  ctx.strokeStyle = "#d9a441";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // The ball track: dark, polished, with a lighter band where the light catches it.
  const track = ctx.createRadialGradient(0, 0, R * TRACK_IN, 0, 0, R * TRACK_OUT);
  track.addColorStop(0, "#1c0d05");
  track.addColorStop(0.45, "#4b2410");
  track.addColorStop(0.8, "#6e3817");
  track.addColorStop(1, "#24110a");
  ctx.beginPath();
  ctx.arc(0, 0, R * TRACK_OUT, 0, Math.PI * 2);
  ctx.fillStyle = track;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, R * TRACK_OUT, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.lineWidth = 3;
  ctx.stroke();

  // The deflectors on the track: eight gold diamonds that knock the ball about.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
    ctx.save();
    ctx.rotate(angle);
    ctx.translate(R * 0.775, 0);
    ctx.beginPath();
    const long = i % 2 ? 11 : 7;
    ctx.moveTo(-long, 0);
    ctx.lineTo(0, -4.5);
    ctx.lineTo(long, 0);
    ctx.lineTo(0, 4.5);
    ctx.closePath();
    const gold = ctx.createLinearGradient(-long, -4, long, 4);
    gold.addColorStop(0, "#fff0b0");
    gold.addColorStop(0.5, "#d9a441");
    gold.addColorStop(1, "#7a5212");
    ctx.fillStyle = gold;
    ctx.fill();
    ctx.restore();
  }
  return canvas;
}

/** The turning wheel, seen from straight above, pocket 0 at the top: numbers, pockets, frets and the cone. */
function drawRotor(wheel: number[], scale: number): HTMLCanvasElement {
  const outer = R * NUMBERS_OUT;
  const size = Math.ceil(2 * outer * scale);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.translate(outer, outer);
  const step = (Math.PI * 2) / wheel.length;

  wheel.forEach((number, index) => {
    const from = -Math.PI / 2 + (index - 0.5) * step;
    const to = from + step;
    const color = colorOf(number);
    const fill = color === "RED" ? POCKET_RED : color === "BLACK" ? POCKET_BLACK : POCKET_GREEN;
    // The number's band.
    ctx.beginPath();
    ctx.arc(0, 0, R * NUMBERS_OUT, from, to);
    ctx.arc(0, 0, R * NUMBERS_IN, to, from, true);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // The pocket under it: the same colour, in shadow.
    ctx.beginPath();
    ctx.arc(0, 0, R * NUMBERS_IN, from, to);
    ctx.arc(0, 0, R * POCKETS_IN, to, from, true);
    ctx.closePath();
    const pocket = ctx.createRadialGradient(0, 0, R * POCKETS_IN, 0, 0, R * NUMBERS_IN);
    pocket.addColorStop(0, "#050505");
    pocket.addColorStop(0.55, fill);
    pocket.addColorStop(1, "#050505");
    ctx.fillStyle = pocket;
    ctx.fill();
    // The number, upright when read from outside the wheel.
    const middle = from + step / 2;
    ctx.save();
    ctx.rotate(middle + Math.PI / 2);
    ctx.fillStyle = "#fff";
    ctx.font = `800 14px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label(number), 0, -R * ((NUMBERS_OUT + NUMBERS_IN) / 2));
    ctx.restore();
  });

  // Gold frets between the pockets, and gold rings round the bands.
  ctx.strokeStyle = "#e2b552";
  ctx.lineWidth = 1.6;
  for (let index = 0; index < wheel.length; index++) {
    const angle = -Math.PI / 2 + (index - 0.5) * step;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * R * POCKETS_IN, Math.sin(angle) * R * POCKETS_IN);
    ctx.lineTo(Math.cos(angle) * R * NUMBERS_OUT, Math.sin(angle) * R * NUMBERS_OUT);
    ctx.stroke();
  }
  for (const [radius, width] of [[NUMBERS_OUT, 2.5], [NUMBERS_IN, 1.6], [POCKETS_IN, 2.5]] as const) {
    ctx.beginPath();
    ctx.arc(0, 0, R * radius - width / 2, 0, Math.PI * 2);
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // The cone: wood, lit from the top left, with four gold spokes.
  const cone = ctx.createRadialGradient(-R * 0.12, -R * 0.14, R * 0.04, 0, 0, R * POCKETS_IN);
  cone.addColorStop(0, "#c0773a");
  cone.addColorStop(0.55, "#7d3e18");
  cone.addColorStop(1, "#3b1a09");
  ctx.beginPath();
  ctx.arc(0, 0, R * POCKETS_IN - 2, 0, Math.PI * 2);
  ctx.fillStyle = cone;
  ctx.fill();
  for (let spoke = 0; spoke < 4; spoke++) {
    ctx.save();
    ctx.rotate((spoke * Math.PI) / 2 + Math.PI / 4);
    const gold = ctx.createLinearGradient(0, -4, 0, 4);
    gold.addColorStop(0, "#fff0b0");
    gold.addColorStop(0.5, "#c9922c");
    gold.addColorStop(1, "#6d4810");
    ctx.fillStyle = gold;
    ctx.beginPath();
    ctx.moveTo(R * 0.1, -3.5);
    ctx.lineTo(R * (POCKETS_IN - 0.04), -1.5);
    ctx.lineTo(R * (POCKETS_IN - 0.04), 1.5);
    ctx.lineTo(R * 0.1, 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  return canvas;
}

type Spin = {
  started: number;
  /** The ball's angle relative to the wheel at the start (already wound back by its turns) and where it ends. */
  from: number;
  to: number;
  /** The ball's distance from the middle when the spin started. */
  fromRadius: number;
  /** A little randomness in how it bounces, so no two spins look the same. */
  wobble: number;
  done(): void;
};

export const RouletteWheel = forwardRef<RouletteWheelHandle, Props>(function RouletteWheel({ wheel, resting, instant }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instantRef = useRef(instant);
  instantRef.current = instant;
  /** Everything the frames share: the wheel's angle, the ball, a spin under way. */
  const live = useRef({
    angle: 0,
    speed: IDLE_SPEED,
    /** The ball relative to the wheel (radians) and its distance from the middle (parts of R); null with no ball. */
    ball: resting === null ? null : { at: -Math.PI / 2 + resting * ((Math.PI * 2) / wheel.length), radius: BALL_POCKET },
    spin: null as Spin | null,
    /** The pocket to light up after a spin, and when it landed. */
    lit: null as { index: number; since: number } | null,
    lastFret: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const bowl = drawBowl(dpr);
    const rotor = drawRotor(wheel, dpr * 1.4);
    const step = (Math.PI * 2) / wheel.length;
    let frame = 0;
    let last = performance.now();

    const point = (angle: number, radius: number, lift = 0) => ({ x: CX + Math.cos(angle) * radius, y: CY + Math.sin(angle) * radius * TILT - lift });

    function drawBall(angle: number, radius: number, lift: number) {
      const at = point(angle, radius * R, lift);
      const size = R * BALL_SIZE;
      // Its shadow on the wheel.
      const ground = point(angle, radius * R);
      ctx!.beginPath();
      ctx!.ellipse(ground.x + 2, ground.y + 2, size * 1.1, size * 0.6, 0, 0, Math.PI * 2);
      ctx!.fillStyle = "rgba(0,0,0,0.45)";
      ctx!.fill();
      const shine = ctx!.createRadialGradient(at.x - size * 0.35, at.y - size * 0.4, size * 0.1, at.x, at.y, size);
      shine.addColorStop(0, "#ffffff");
      shine.addColorStop(0.6, "#e9e9ee");
      shine.addColorStop(1, "#8d8d99");
      ctx!.beginPath();
      ctx!.arc(at.x, at.y, size, 0, Math.PI * 2);
      ctx!.fillStyle = shine;
      ctx!.fill();
    }

    /** The turret in the middle: a gold post with a cross handle that turns with the wheel. */
    function drawTurret(angle: number) {
      const base = R * 0.11;
      const height = R * 0.2;
      const gold = ctx!.createLinearGradient(CX - base, 0, CX + base, 0);
      gold.addColorStop(0, "#7a5212");
      gold.addColorStop(0.35, "#fff0b0");
      gold.addColorStop(0.6, "#d9a441");
      gold.addColorStop(1, "#6d4810");
      // The base dome.
      ctx!.beginPath();
      ctx!.ellipse(CX, CY, base, base * TILT, 0, 0, Math.PI * 2);
      ctx!.fillStyle = gold;
      ctx!.fill();
      ctx!.beginPath();
      ctx!.ellipse(CX, CY - base * 0.35, base * 0.72, base * 0.72 * TILT, 0, 0, Math.PI * 2);
      ctx!.fillStyle = gold;
      ctx!.fill();
      // The arms, behind the post first, then in front of it.
      const arms = [0, 1, 2, 3].map((arm) => angle + Math.PI / 4 + (arm * Math.PI) / 2);
      const top = height * 0.72;
      const drawArm = (armAngle: number) => {
        const end = point(armAngle, R * 0.16, top);
        ctx!.beginPath();
        ctx!.moveTo(CX, CY - top);
        ctx!.lineTo(end.x, end.y);
        ctx!.strokeStyle = "#c9922c";
        ctx!.lineWidth = 4;
        ctx!.lineCap = "round";
        ctx!.stroke();
        const knob = ctx!.createRadialGradient(end.x - 2, end.y - 2, 1, end.x, end.y, 6);
        knob.addColorStop(0, "#fff7d1");
        knob.addColorStop(1, "#a8761f");
        ctx!.beginPath();
        ctx!.arc(end.x, end.y, 5.5, 0, Math.PI * 2);
        ctx!.fillStyle = knob;
        ctx!.fill();
      };
      arms.filter((armAngle) => Math.sin(armAngle) < 0).forEach(drawArm);
      // The post.
      ctx!.fillStyle = gold;
      ctx!.fillRect(CX - 4, CY - height, 8, height - base * 0.3);
      ctx!.beginPath();
      ctx!.arc(CX, CY - height, 7, 0, Math.PI * 2);
      ctx!.fillStyle = gold;
      ctx!.fill();
      arms.filter((armAngle) => Math.sin(armAngle) >= 0).forEach(drawArm);
    }

    function render(now: number) {
      const state = live.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // The wheel turns all the time, faster for a while after a spin starts.
      state.speed += (IDLE_SPEED - state.speed) * Math.min(1, dt * 0.35);
      if (!instantRef.current || state.spin) state.angle += state.speed * dt;

      // The ball: on a spin, round the track, then down into its pocket.
      let lift = 0;
      const spin = state.spin;
      if (spin && state.ball) {
        const u = Math.min(1, (now - spin.started) / SPIN_MS);
        const eased = easeOutCubic(u);
        let at = spin.from + (spin.to - spin.from) * eased;
        let radius: number;
        if (u < 0.06) {
          // Picked up and thrown onto the track.
          radius = spin.fromRadius + (BALL_TRACK + 0.02 - spin.fromRadius) * (u / 0.06);
          lift = Math.sin((u / 0.06) * Math.PI) * 14;
        } else if (u < DROP_AT) {
          // Round the track, edging inwards as it slows.
          radius = BALL_TRACK + 0.02 - 0.03 * ((u - 0.06) / (DROP_AT - 0.06));
        } else {
          // Down off the track, hopping across the frets, then still.
          const v = (u - DROP_AT) / (1 - DROP_AT);
          const hops = Math.abs(Math.cos(v * Math.PI * (3 + spin.wobble))) * (1 - v) ** 2.2;
          radius = BALL_POCKET + (BALL_TRACK - 0.01 - BALL_POCKET) * Math.max(hops, (1 - Math.min(1, v * 3)) ** 2);
          lift = hops * 10;
          at += Math.sin(v * Math.PI * 5) * 0.12 * (1 - v) ** 2 * spin.wobble;
          // A click each time it crosses a fret.
          const fret = Math.floor((at + Math.PI / 2) / step + 0.5);
          if (fret !== state.lastFret && radius < 0.66) {
            state.lastFret = fret;
            slotSound.pocketTick(1 - v);
          }
        }
        state.ball = { at, radius };
        if (u >= 1) {
          state.ball = { at: spin.to, radius: BALL_POCKET };
          state.spin = null;
          state.lit = { index: Math.round((spin.to + Math.PI / 2) / step), since: now };
          slotSound.ballStop();
          spin.done();
        }
      }

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, W, H);
      // The bowl's side and its shadow, then the bowl, seen at an angle.
      ctx!.beginPath();
      ctx!.ellipse(CX, CY + DEPTH + 8, R * 1.01, R * TILT * 1.01, 0, 0, Math.PI * 2);
      ctx!.fillStyle = "rgba(0,0,0,0.35)";
      ctx!.fill();
      const side = ctx!.createLinearGradient(CX - R, 0, CX + R, 0);
      side.addColorStop(0, "#2a1206");
      side.addColorStop(0.5, "#5c2b10");
      side.addColorStop(1, "#2a1206");
      ctx!.beginPath();
      ctx!.ellipse(CX, CY + DEPTH, R, R * TILT, 0, 0, Math.PI);
      ctx!.lineTo(CX - R, CY);
      ctx!.ellipse(CX, CY, R, R * TILT, 0, Math.PI, 0, true);
      ctx!.closePath();
      ctx!.fillStyle = side;
      ctx!.fill();

      ctx!.save();
      ctx!.translate(CX, CY);
      ctx!.scale(1, TILT);
      ctx!.drawImage(bowl, -R, -R, 2 * R, 2 * R);
      // The wheel sits a little lower than the track.
      ctx!.beginPath();
      ctx!.arc(0, 0, R * TRACK_IN, 0, Math.PI * 2);
      ctx!.fillStyle = "#120803";
      ctx!.fill();
      ctx!.rotate(state.angle);
      const outer = R * NUMBERS_OUT;
      ctx!.drawImage(rotor, -outer, -outer, 2 * outer, 2 * outer);
      // The winning pocket glows for a while.
      if (state.lit && now - state.lit.since < 6000) {
        const from = -Math.PI / 2 + (state.lit.index - 0.5) * step;
        const pulse = 0.55 + 0.45 * Math.sin((now - state.lit.since) / 160);
        ctx!.beginPath();
        ctx!.arc(0, 0, R * NUMBERS_OUT, from, from + step);
        ctx!.arc(0, 0, R * POCKETS_IN, from + step, from, true);
        ctx!.closePath();
        ctx!.fillStyle = `rgba(255, 236, 140, ${0.35 * pulse})`;
        ctx!.fill();
        ctx!.strokeStyle = `rgba(255, 236, 140, ${pulse})`;
        ctx!.lineWidth = 3;
        ctx!.stroke();
      }
      ctx!.restore();

      // Behind the turret or in front of it, depending on which side of the wheel the ball is.
      const ball = state.ball;
      const ballAngle = ball ? state.angle + ball.at : 0;
      const behind = ball !== null && Math.sin(ballAngle) < 0;
      if (ball && behind) drawBall(ballAngle, ball.radius, lift);
      drawTurret(state.angle);
      if (ball && !behind) drawBall(ballAngle, ball.radius, lift);

      frame = requestAnimationFrame(render);
    }
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [wheel]);

  useImperativeHandle(
    ref,
    () => ({
      spin(stop) {
        const state = live.current;
        const step = (Math.PI * 2) / wheel.length;
        const target = -Math.PI / 2 + stop * step;
        if (instantRef.current) {
          state.ball = { at: target, radius: BALL_POCKET };
          state.spin?.done();
          state.spin = null;
          state.lit = { index: stop, since: performance.now() };
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          state.spin?.done();
          // The ball starts where it is now (or at the front of the track) and runs against the wheel, ending TURNS turns later in its pocket.
          const now = state.ball?.at ?? Math.PI / 2 - state.angle;
          const ahead = (((now - target) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          state.speed = SPIN_SPEED;
          state.lit = null;
          state.lastFret = 0;
          state.spin = { started: performance.now(), from: target + ahead + TURNS * Math.PI * 2, to: target, fromRadius: state.ball?.radius ?? BALL_TRACK, wobble: 0.6 + Math.random() * 0.8, done: resolve };
          state.ball = { at: target + ahead, radius: state.ball?.radius ?? BALL_TRACK };
          slotSound.ballRoll(SPIN_MS * DROP_AT);
        });
      },
    }),
    [wheel.length],
  );

  return <canvas ref={canvasRef} className="roulette-wheel" width={W} height={H} aria-hidden="true" />;
});
