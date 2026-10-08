"use client";

import { memo } from "react";
import type { PenaltyDirection } from "../lib/api";
import { useI18n } from "./i18n-provider";

/**
 * The Penalty game's picture: a floodlit stadium seen from behind the penalty
 * taker, the goal with its net, the keeper and the ball. Everything sits in
 * one "world" 1000 wide by 800 tall that keeps its shape and is cropped at
 * the sides on narrow screens, so the goal, the keeper and the ball's flight
 * always line up. The keeper and the taker are drawn from a skeleton (hips,
 * spine, shoulders, elbows, knees), so each pose bends like a person.
 */

export type PenaltyKick = { aim: PenaltyDirection; dive: PenaltyDirection; goal: boolean };

const SIDES = ["LEFT", "CENTER", "RIGHT"] as const satisfies readonly PenaltyDirection[];
const sideName = (side: PenaltyDirection) => (side === "LEFT" ? "Left" : side === "RIGHT" ? "Right" : "Center");

export function PenaltyScene({
  last,
  fresh,
  call,
  canShoot,
  onShoot,
  kickNumber = 0,
  still = false,
}: {
  /** The latest kick, if any. */
  last: PenaltyKick | null;
  /** Whether that kick was just taken (it animates) rather than shown where it ended. */
  fresh: boolean;
  call: "goal" | "save" | null;
  canShoot: boolean;
  onShoot: (side: PenaltyDirection) => void;
  /** How many kicks the round has had, so saves vary between catches and parries. */
  kickNumber?: number;
  /** Just the picture, waiting for the kick: no aiming buttons, for the Casino's tile. */
  still?: boolean;
}) {
  const { t } = useI18n();
  const motion = last ? (fresh ? "is-moving" : "is-done") : "";
  const dive = last?.dive ?? null;
  // A save is caught two times in three, otherwise parried: out past the post, or over the bar from the middle.
  const save: SaveKind | null = last && !last.goal ? (kickNumber % 3 === 1 ? "parry" : "catch") : null;
  const contact = last ? contactPoint(last.dive, save ?? "parry") : null;
  const world = contact ? ({ "--pk-cl": `${f((contact[0] - 17) / 10)}%`, "--pk-ct": `${f((contact[1] - 17) / 8)}%` } as React.CSSProperties) : undefined;
  // Every kick remounts the moving parts (so their animations play again), and the camera's move alternates between two identical animations to restart.
  const kick = `${kickNumber}-${motion || "ready"}`;
  const camera = last && fresh ? ` is-kick-${kickNumber % 2 ? "a" : "b"}` : "";
  return (
    <div aria-hidden={still || undefined} className={`penalty-scene${still ? " is-still" : ""}${call === "goal" ? " is-goal" : ""}${call === "save" ? " is-save" : ""}${last ? ` is-aim-${last.aim.toLowerCase()}` : ""}${camera}`}>
      <div className="pk-world" style={world}>
        <Stadium />
        <div className="pk-targets" aria-hidden="true">
          {SIDES.map((side) => (
            <span key={side} className={`pk-target is-${side.toLowerCase()}`} />
          ))}
        </div>
        <span key={`shadow-${kick}`} className={`pk-keeper-shadow${dive ? ` is-${dive.toLowerCase()} ${motion}` : ""}`} aria-hidden="true" />
        <div
          key={`keeper-${kick}-${dive ?? "ready"}-${save ?? "none"}`}
          className={`pk-keeper${dive ? ` is-${dive.toLowerCase()} ${dive === "CENTER" ? "is-up" : "is-side"} ${motion}${save ? ` is-${save}` : ""}` : " is-ready"}`}
          aria-hidden="true"
        >
          <div className="pk-keeper-body">
            <div className="pk-keeper-fake">
              <svg viewBox="0 0 200 200" className={dive === "RIGHT" ? "is-mirrored" : undefined}>
                <KeeperRig dive={dive} save={save} />
              </svg>
            </div>
          </div>
        </div>
        <span
          key={`ball-${kick}-${last ? `${last.aim}-${last.dive}` : "ready"}-${save ?? "goal"}`}
          className={`pk-ball${last ? ` is-${last.aim.toLowerCase()} ${motion}${last.goal ? " is-goal" : ` is-saved is-${save}`}` : ""}`}
          aria-hidden="true"
        >
          <Ball />
        </span>
        <span
          key={`ball-shadow-${kick}`}
          className={`pk-ball-shadow${last ? ` is-${last.aim.toLowerCase()} ${motion}${last.goal ? " is-goal" : " is-saved"}` : ""}`}
          aria-hidden="true"
        />
        <GoalFrame />
        <div key={`taker-${kick}`} className={`pk-taker${last ? (fresh ? " is-kicking" : " is-done") : ""}`} aria-hidden="true">
          <svg viewBox="0 0 200 260">
            <TakerRig kicked={Boolean(last)} scored={last?.goal ?? false} />
          </svg>
        </div>
        {still ? null : (
          <div className="pk-zones" role="group" aria-label={t("The goal")}>
            {SIDES.map((side) => (
              <button
                key={side}
                type="button"
                className={`pk-zone is-${side.toLowerCase()}${last?.aim === side ? " is-aimed" : ""}`}
                data-key={side === "LEFT" ? "ArrowLeft" : side === "RIGHT" ? "ArrowRight" : "ArrowUp"}
                disabled={!canShoot}
                aria-label={t("Shoot {side}", { side: t(sideName(side)) })}
                onClick={() => onShoot(side)}
              >
                <span>{t(sideName(side))}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pk-vignette" aria-hidden="true" />
      {call ? <p className={`penalty-call is-${call}`}>{call === "goal" ? t("Goal!") : t("Saved!")}</p> : null}
    </div>
  );
}

/* ---------- The stadium, the pitch and the back of the goal ---------- */

/** Where the mown stripes change, from the ad boards (322) to the bottom (800): wider the nearer they are. */
const STRIPES = (() => {
  const top = 322;
  const bottom = 800;
  const bands = 13;
  const ratio = 1.16;
  const unit = (bottom - top) * ((ratio - 1) / (ratio ** bands - 1));
  const edges = [top];
  for (let i = 0; i < bands; i += 1) edges.push(edges[i] + unit * ratio ** i);
  return edges;
})();

/** Where camera flashes go off in the stands, and when in their cycle: [x, y, delay in seconds]. */
const FLASHES: Array<[number, number, number]> = [
  [62, 70, 0], [188, 112, 1.3], [305, 82, 2.7], [431, 132, 0.6], [557, 64, 3.4], [672, 118, 1.9], [811, 90, 4.1], [930, 128, 2.2],
  [120, 204, 3.0], [246, 252, 0.9], [377, 218, 4.4], [618, 262, 1.6], [745, 196, 3.8], [876, 240, 0.3],
];

/** Crowd colours: shirts, scarves and faces under the lights. */
const CROWD = ["#c8102e", "#f2f2f2", "#1d3f8f", "#ffd34d", "#2a2a2a", "#e98b6d", "#8a5a44", "#d8d8d8", "#6b1020", "#3a6fd8"];

const Stadium = memo(function Stadium() {
  // Seat rows in two tiers, each a row of heads in shuffled colours (made once, the same every time).
  const rows: Array<{ y: number; r: number; gap: number; offset: number; colors: string[] }> = [];
  let seed = 7;
  const next = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const tier = (from: number, to: number, size: number) => {
    for (let y = from, i = 0; y < to; y += size * 2.3, i += 1) {
      const r = size * (0.85 + ((y - from) / (to - from)) * 0.3);
      rows.push({ y, r, gap: r * 2.35, offset: (i % 2) * r * 1.2, colors: Array.from({ length: 12 }, () => CROWD[Math.floor(next() * CROWD.length)]) });
    }
  };
  tier(58, 150, 3.2);
  tier(176, 284, 3.9);
  return (
    <svg className="pk-stadium" viewBox="0 0 1000 800" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="pk-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#03060f" />
          <stop offset="1" stopColor="#0b1830" />
        </linearGradient>
        <linearGradient id="pk-tier-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="#000" stopOpacity="0.15" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="pk-flood" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff9e6" stopOpacity="0.95" />
          <stop offset="0.25" stopColor="#ffe9a8" stopOpacity="0.45" />
          <stop offset="1" stopColor="#ffe9a8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pk-grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1f7a3a" />
          <stop offset="1" stopColor="#2f9a4a" />
        </linearGradient>
        <radialGradient id="pk-pitch-light" cx="0.5" cy="0.15" r="0.75">
          <stop offset="0" stopColor="#fffbe0" stopOpacity="0.18" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pk-edge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.45" />
          <stop offset="0.18" stopColor="#000" stopOpacity="0" />
          <stop offset="0.82" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.45" />
        </linearGradient>
        {/* Grass: short blades in lighter and darker greens. */}
        <pattern id="pk-blades" width="23" height="17" patternUnits="userSpaceOnUse">
          <path d="M2 14 l1 -4 M7 16 l-1 -3.5 M12 13 l1.2 -3 M17 15 l-0.8 -4 M21 12 l1 -3 M4 6 l1 -3 M10 5 l-1 -3.2 M15 7 l1 -3 M19 4 l-0.8 -3" stroke="#0e4a22" strokeWidth="0.9" opacity="0.6" />
          <path d="M5 11 l0.8 -3 M9 9 l-0.6 -3 M14 11 l0.9 -3.4 M20 9 l-0.7 -3 M1 3 l0.8 -2.5 M12 2 l0.8 -2" stroke="#7fd08a" strokeWidth="0.7" opacity="0.35" />
        </pattern>
        <pattern id="pk-mesh" width="9" height="9" patternUnits="userSpaceOnUse">
          <path d="M0 4.5 L4.5 0 L9 4.5 L4.5 9 Z" fill="none" stroke="#eef4f2" strokeWidth="0.7" strokeOpacity="0.55" />
        </pattern>
        <pattern id="pk-mesh-side" width="7" height="9" patternUnits="userSpaceOnUse">
          <path d="M0 4.5 L3.5 0 L7 4.5 L3.5 9 Z" fill="none" stroke="#eef4f2" strokeWidth="0.6" strokeOpacity="0.4" />
        </pattern>
        <linearGradient id="pk-board" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#10151f" />
          <stop offset="1" stopColor="#05080d" />
        </linearGradient>
      </defs>

      {/* Night sky and the roof. */}
      <rect width="1000" height="330" fill="url(#pk-sky)" />
      <path d="M0 0 H1000 V34 Q500 52 0 34 Z" fill="#05070c" />
      {Array.from({ length: 24 }, (_, i) => (
        <circle key={i} cx={22 + i * 41.5} cy={36 + Math.sin((i / 23) * Math.PI) * 8} r="1.6" fill="#fff5d6" opacity="0.75" />
      ))}

      {/* Upper tier, the balcony, the lower tier. */}
      <rect y="46" width="1000" height="110" fill="#141a26" />
      <rect y="168" width="1000" height="122" fill="#171d2a" />
      {rows.map((row, i) => (
        <g key={i} className={`pk-crowd ${i % 2 ? "is-odd" : "is-even"}`}>
          {Array.from({ length: Math.ceil(1000 / row.gap) + 1 }, (_, k) => {
            const x = row.offset + k * row.gap;
            const color = row.colors[(k * 7 + i) % row.colors.length];
            return (
              <g key={k}>
                <rect x={x - row.r * 1.05} y={row.y + row.r * 0.6} width={row.r * 2.1} height={row.r * 1.6} rx={row.r * 0.6} fill={color} opacity="0.85" />
                <circle cx={x} cy={row.y} r={row.r * 0.72} fill={(k + i) % 5 === 0 ? "#3b2a20" : (k + i) % 3 === 0 ? "#c58c6a" : "#e0a989"} opacity="0.9" />
              </g>
            );
          })}
        </g>
      ))}
      {/* Phone cameras flashing here and there in the stands. */}
      {FLASHES.map(([x, y, delay], i) => (
        <circle key={`flash${i}`} className="pk-flash" cx={x} cy={y} r="2.6" fill="#ffffff" style={{ animationDelay: `${delay}s` }} />
      ))}
      <rect y="46" width="1000" height="110" fill="url(#pk-tier-shade)" />
      <rect y="168" width="1000" height="122" fill="url(#pk-tier-shade)" />
      {/* The balcony's LED ring. */}
      <rect y="152" width="1000" height="18" fill="#090c13" />
      <rect y="156" width="1000" height="10" fill="#0e1830" />
      {Array.from({ length: 6 }, (_, i) => (
        <text key={i} x={80 + i * 170} y="164.5" fontSize="9" fontWeight="900" fontFamily="system-ui, sans-serif" fill={i % 2 ? "#7cf29a" : "#ffe14a"} letterSpacing="2">
          BAST.AL
        </text>
      ))}
      {/* Steps in the lower tier. */}
      <path d="M498 168 L494 290 M506 168 L510 290" stroke="#0b0f17" strokeWidth="5" />

      {/* Floodlights on their towers, and their glow. */}
      {[60, 940].map((x) => (
        <g key={x}>
          <path d={`M${x - 4} 0 L${x - 2} 120 H${x + 2} L${x + 4} 0 Z`} fill="#1a1f2a" />
          <rect x={x - 34} y="2" width="68" height="34" rx="3" fill="#20262f" />
          {Array.from({ length: 12 }, (_, k) => (
            <rect key={k} x={x - 31 + (k % 6) * 10.6} y={5 + Math.floor(k / 6) * 15} width="8.5" height="12" rx="1.5" fill="#fffbea" />
          ))}
          <circle cx={x} cy="19" r="120" fill="url(#pk-flood)" />
        </g>
      ))}

      {/* Ad boards along the goal line. */}
      <rect y="290" width="1000" height="34" fill="url(#pk-board)" />
      {["BAST.AL", "LIVE BETTING", "BAST.AL", "CASINO", "BAST.AL", "PENALTY"].map((word, i) => (
        <g key={i}>
          <rect x={4 + i * 166.5} y="293" width="160" height="27" rx="2" fill={i % 2 ? "#0f2a5c" : "#132a14"} />
          <text x={84 + i * 166.5} y="312.5" textAnchor="middle" fontSize="15" fontWeight="900" fontFamily="system-ui, sans-serif" fill={i % 2 ? "#9fd0ff" : "#c6ff6a"} letterSpacing="1.5">
            {word}
          </text>
        </g>
      ))}

      {/* The pitch: mown stripes, wider nearer, lit from the top. */}
      <rect y="322" width="1000" height="478" fill="url(#pk-grass)" />
      <rect y="322" width="1000" height="478" fill="url(#pk-blades)" opacity="0.55" />
      {STRIPES.slice(0, -1).map((y, i) => (i % 2 ? <rect key={i} y={y} width="1000" height={STRIPES[i + 1] - y} fill="#ffffff" opacity="0.055" /> : null))}
      <rect y="322" width="1000" height="478" fill="url(#pk-pitch-light)" />
      <rect y="322" width="1000" height="478" fill="url(#pk-edge)" />

      {/* Shadows of the goal on the grass. */}
      <path d="M272 562 L240 590 H760 L728 562 Z" fill="#000" opacity="0.14" />

      {/* Markings: the goal line, the six-yard box, the penalty area, the spot and the arc. */}
      <g className="pk-lines">
        <path d="M-20 560 H1020" />
        <path d="M222 560 L196 600 H804 L778 560" />
        <path d="M92 560 L-26 738 H1026 L908 560" />
        <path d="M402 738 Q500 790 598 738" />
      </g>
      <ellipse cx="500" cy="672" rx="9" ry="3.6" fill="#f6faf3" opacity="0.92" />

      {/* The goal's net: roof, sides and back, behind the keeper. */}
      <g className="pk-backnet">
        <path d="M280 388 L312 406 V528 L280 560 Z" fill="#0b2a18" opacity="0.55" />
        <path d="M720 388 L688 406 V528 L720 560 Z" fill="#0b2a18" opacity="0.55" />
        <path d="M312 406 H688 V528 H312 Z" fill="#0d3220" opacity="0.6" />
        <path d="M312 406 H688 V528 H312 Z" fill="url(#pk-mesh)" />
        <path d="M280 388 L312 406 V528 L280 560 Z" fill="url(#pk-mesh-side)" />
        <path d="M720 388 L688 406 V528 L720 560 Z" fill="url(#pk-mesh-side)" />
        <path d="M280 388 H720 L688 406 H312 Z" fill="url(#pk-mesh-side)" />
        <path d="M312 406 V528 M688 406 V528 M312 406 H688" stroke="#cfd6de" strokeWidth="2.2" fill="none" opacity="0.7" />
        <path d="M312 528 H688" stroke="#e8eef3" strokeWidth="1.6" opacity="0.5" />
      </g>
    </svg>
  );
});

/** The posts and the crossbar, in front of the keeper and the ball. */
const GoalFrame = memo(function GoalFrame() {
  return (
    <svg className="pk-frame" viewBox="0 0 1000 800" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="pk-post" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#aeb8c4" />
          <stop offset="0.35" stopColor="#ffffff" />
          <stop offset="0.7" stopColor="#e3e9ef" />
          <stop offset="1" stopColor="#8e99a6" />
        </linearGradient>
        <linearGradient id="pk-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#e3e9ef" />
          <stop offset="1" stopColor="#9aa6b4" />
        </linearGradient>
      </defs>
      <rect x="270" y="380" width="14" height="183" rx="4" fill="url(#pk-post)" />
      <rect x="716" y="380" width="14" height="183" rx="4" fill="url(#pk-post)" />
      <rect x="270" y="378" width="460" height="13" rx="5" fill="url(#pk-bar)" />
      <path d="M284 391 H716" stroke="#000" strokeOpacity="0.18" strokeWidth="3" />
    </svg>
  );
});

/* ---------- People, drawn from a skeleton ---------- */

type Point = [number, number];
/** A limb's two bones as angles in degrees: 0 points straight down, 90 to the right, -90 to the left. */
type Limb = [upper: number, lower: number];
type Pose = {
  pelvis: Point;
  spine: number;
  head: number;
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
  /** Limbs reaching toward or away from the camera look shorter: their length as a share of the full one. */
  len?: Partial<Record<"armL" | "armR" | "legL" | "legR", number>>;
};

const rad = (deg: number) => (deg * Math.PI) / 180;
const along = (from: Point, angle: number, length: number): Point => [from[0] + Math.sin(rad(angle)) * length, from[1] + Math.cos(rad(angle)) * length];
/** A point given in the body's own frame (y up the spine), turned with the spine and placed at the pelvis. */
const body = (pose: Pose, x: number, y: number): Point => {
  const a = rad(pose.spine);
  return [pose.pelvis[0] + x * Math.cos(a) - y * Math.sin(a), pose.pelvis[1] + x * Math.sin(a) + y * Math.cos(a)];
};
const f = (n: number) => Math.round(n * 10) / 10;

/** A rounded, tapering limb segment from a to b, with round ends bulging outward. */
function capsule(a: Point, b: Point, ra: number, rb: number): string {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return `M${f(a[0] + nx * ra)} ${f(a[1] + ny * ra)} L${f(b[0] + nx * rb)} ${f(b[1] + ny * rb)} A${rb} ${rb} 0 0 0 ${f(b[0] - nx * rb)} ${f(b[1] - ny * rb)} L${f(a[0] - nx * ra)} ${f(a[1] - ny * ra)} A${ra} ${ra} 0 0 0 ${f(a[0] + nx * ra)} ${f(a[1] + ny * ra)} Z`;
}

/** A limb with a soft highlight along its lit side. */
function Segment({ a, b, ra, rb, fill, light }: { a: Point; b: Point; ra: number; rb: number; fill: string; light?: string }) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const off: Point = [(-dy / len) * ra * 0.4, (dx / len) * ra * 0.4];
  const side = off[0] + off[1] < 0 ? 1 : -1;
  return (
    <>
      <path d={capsule(a, b, ra, rb)} fill={fill} />
      {/* The side away from the lights, a little darker. */}
      <path d={capsule([a[0] - off[0] * side * 0.9, a[1] - off[1] * side * 0.9], [b[0] - off[0] * side * 0.9, b[1] - off[1] * side * 0.9], ra * 0.55, rb * 0.55)} fill="#000" opacity="0.13" />
      {light ? <path d={capsule([a[0] + off[0] * side, a[1] + off[1] * side], [b[0] + off[0] * side, b[1] + off[1] * side], ra * 0.35, rb * 0.35)} fill={light} opacity="0.35" /> : null}
    </>
  );
}

type Joints = {
  neck: Point;
  head: Point;
  shoulders: [Point, Point];
  elbows: [Point, Point];
  wrists: [Point, Point];
  hips: [Point, Point];
  knees: [Point, Point];
  ankles: [Point, Point];
};

function joints(pose: Pose, size: { torso: number; shoulder: number; hip: number; upperArm: number; forearm: number; thigh: number; shin: number; neck: number }): Joints {
  const neck = body(pose, 0, -size.torso);
  const shoulders: [Point, Point] = [body(pose, -size.shoulder, -size.torso + 7), body(pose, size.shoulder, -size.torso + 7)];
  const hips: [Point, Point] = [body(pose, -size.hip, -3), body(pose, size.hip, -3)];
  const k = (limb: "armL" | "armR" | "legL" | "legR") => pose.len?.[limb] ?? 1;
  const elbows: [Point, Point] = [along(shoulders[0], pose.armL[0], size.upperArm * k("armL")), along(shoulders[1], pose.armR[0], size.upperArm * k("armR"))];
  const wrists: [Point, Point] = [along(elbows[0], pose.armL[1], size.forearm * k("armL")), along(elbows[1], pose.armR[1], size.forearm * k("armR"))];
  const knees: [Point, Point] = [along(hips[0], pose.legL[0], size.thigh * k("legL")), along(hips[1], pose.legR[0], size.thigh * k("legR"))];
  const ankles: [Point, Point] = [along(knees[0], pose.legL[1], size.shin * k("legL")), along(knees[1], pose.legR[1], size.shin * k("legR"))];
  return { neck, head: body(pose, 0, -size.torso - size.neck), shoulders, elbows, wrists, hips, knees, ankles };
}

/* ---------- The keeper ---------- */

type KeeperPoseName = "ready" | "spread" | "load" | "flight" | "landed" | "crouch" | "jump" | "hold";
type SaveKind = "catch" | "parry";

/**
 * Standing poses have the feet on the ground at y 196. Dives are drawn to
 * the left (the picture is mirrored for the right): the keeper loads,
 * flies at full stretch, then lands on his side and slides.
 */
const KEEPER_POSES: Record<KeeperPoseName, Pose> = {
  // Crouched on the line, weight forward, gloves out and open.
  ready: { pelvis: [100, 118], spine: 0, head: 0, armL: [-38, -8], armR: [38, 8], legL: [-24, 6], legR: [24, -6] },
  // Making himself big to put the taker off: arms up and wide, feet apart.
  spread: { pelvis: [100, 120], spine: 0, head: 0, armL: [-126, -148], armR: [126, 148], legL: [-30, 4], legR: [30, -4] },
  // Loading the dive: dropped low, leaning in, arms swinging that way.
  load: { pelvis: [96, 128], spine: -18, head: -12, armL: [-70, -40], armR: [-14, 22], legL: [-36, -6], legR: [26, -18] },
  // Full stretch in the air: arms past the head, the body flat, legs trailing.
  flight: { pelvis: [128, 112], spine: -78, head: -70, armL: [-112, -104], armR: [-98, -96], legL: [68, 88], legR: [98, 70] },
  // Down on his side along the line, arms still reaching.
  landed: { pelvis: [138, 172], spine: -87, head: -82, armL: [-102, -96], armR: [-92, -88], legL: [84, 102], legR: [98, 84] },
  // Loading a jump in the middle.
  crouch: { pelvis: [100, 130], spine: 0, head: 0, armL: [-46, -18], armR: [46, 18], legL: [-36, 12], legR: [36, -12] },
  // Up in the middle, arms high.
  jump: { pelvis: [100, 104], spine: 0, head: 0, armL: [-158, -170], armR: [158, 170], legL: [-10, -4], legR: [12, 6] },
  // Up in the middle, the ball gathered into the chest.
  hold: { pelvis: [100, 106], spine: 0, head: 0, armL: [-24, 62], armR: [24, -62], legL: [-12, 4], legR: [12, -4] },
};

const KEEPER_SIZE = { torso: 54, shoulder: 23, hip: 13, upperArm: 27, forearm: 25, thigh: 35, shin: 36, neck: 17 };
const KIT = { shirt: "#c6f135", shirtDark: "#86ad12", shirtLight: "#ecff9e", shorts: "#15181d", socks: "#c6f135", skin: "#d9a07a", skinDark: "#b67d58", skinLight: "#f1c39f", hair: "#1f1712" };

/** Where the ball sits when it's in the gloves: between the two palms, a little past the wrists. */
function heldBall(name: KeeperPoseName): Point {
  const pose = KEEPER_POSES[name];
  const j = joints(pose, KEEPER_SIZE);
  const palm = (s: 0 | 1) => along(j.wrists[s], s === 0 ? pose.armL[1] : pose.armR[1], 9);
  const [a, b] = [palm(0), palm(1)];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/*
 * The keeper's moves, in the same numbers as the keyframes in globals.css
 * (pk-keep-x-left and pk-keep-y-side, pk-keep-y-up): the box is 170 world units at
 * x 415, y 395.2, turned about its point (85, 153); at the moment the ball
 * arrives (44% of the move) a dive is 46% across, turned 10° and 13.5% up,
 * and a jump is 12% up.
 */
const BOX = { x: 415, y: 395.2, size: 170, origin: [85, 153] as Point };
const AT_CONTACT = { side: { x: -0.46, y: -0.135, turn: -10 }, up: { x: 0, y: -0.12, turn: 0 } };

/** Where, in the world, the ball meets the keeper's gloves (or chest) on a save. */
function contactPoint(dive: PenaltyDirection, save: SaveKind): Point {
  const side = dive !== "CENTER";
  const pose: KeeperPoseName = side ? "flight" : save === "catch" ? "hold" : "jump";
  const local = heldBall(pose);
  const move = side ? AT_CONTACT.side : AT_CONTACT.up;
  const scale = BOX.size / 200;
  const q: Point = [local[0] * scale, local[1] * scale + move.y * BOX.size];
  const a = rad(move.turn);
  const d: Point = [q[0] - BOX.origin[0], q[1] - BOX.origin[1]];
  const r: Point = [BOX.origin[0] + d[0] * Math.cos(a) - d[1] * Math.sin(a) + move.x * BOX.size, BOX.origin[1] + d[0] * Math.sin(a) + d[1] * Math.cos(a)];
  const world: Point = [BOX.x + r[0], BOX.y + r[1]];
  return dive === "RIGHT" ? [1000 - world[0], world[1]] : world;
}

/** Every pose the move needs, layered; the stylesheet shows each in its turn (ready until the taker strikes). A caught ball rides in the gloves. */
function KeeperRig({ dive, save }: { dive: PenaltyDirection | null; save: SaveKind | null }) {
  // Waiting: the crouch, now and then spreading himself big (the stylesheet times it with his sway).
  if (!dive)
    return (
      <>
        <g className="pk-idle-pose is-ready">
          <KeeperFigure name="ready" />
        </g>
        <g className="pk-idle-pose is-spread">
          <KeeperFigure name="spread" />
        </g>
      </>
    );
  const caught = save === "catch";
  if (dive === "CENTER") {
    const air: KeeperPoseName = caught ? "hold" : "jump";
    return (
      <>
        <g className="pk-pose is-ready">
          <KeeperFigure name="ready" />
        </g>
        <g className="pk-pose is-crouch">
          <KeeperFigure name="crouch" />
        </g>
        <g className="pk-pose is-air">
          <KeeperFigure name={air} />
          {caught ? <HeldBall at={heldBall(air)} className="pk-held is-air" /> : null}
        </g>
      </>
    );
  }
  return (
    <>
      <g className="pk-pose is-ready">
        <KeeperFigure name="ready" />
      </g>
      <g className="pk-pose is-load">
        <KeeperFigure name="load" />
      </g>
      <g className="pk-pose is-flight">
        <KeeperFigure name="flight" />
        {caught ? <HeldBall at={heldBall("flight")} className="pk-held is-flight" /> : null}
      </g>
      <g className="pk-pose is-landed">
        <KeeperFigure name="landed" />
        {caught ? <HeldBall at={heldBall("landed")} className="pk-held is-landed" /> : null}
      </g>
    </>
  );
}

/** The ball held in the gloves: 34 world units across, as the ball is at the goal (0.6 of it). */
function HeldBall({ at, className }: { at: Point; className: string }) {
  const size = 24;
  return (
    <g className={className}>
      <svg x={f(at[0] - size / 2)} y={f(at[1] - size / 2)} width={size} height={size} viewBox="0 0 64 64" overflow="visible">
        <BallArt id="held" />
      </svg>
    </g>
  );
}

/** A figure with a dark outline: drawn once as a silhouette a little larger (see .pk-outline), then in colour on top. */
function Outlined({ children }: { children: React.ReactNode }) {
  return (
    <g>
      <g className="pk-outline">{children}</g>
      {children}
    </g>
  );
}

function KeeperFigure({ name }: { name: KeeperPoseName }) {
  return (
    <Outlined>
      <KeeperDrawing name={name} />
    </Outlined>
  );
}

function KeeperDrawing({ name }: { name: KeeperPoseName }) {
  const pose = KEEPER_POSES[name];
  const j = joints(pose, KEEPER_SIZE);
  const torsoAngle = pose.spine;
  const forearmAngle = (side: 0 | 1) => (side === 0 ? pose.armL[1] : pose.armR[1]);
  const shinAngle = (side: 0 | 1) => (side === 0 ? pose.legL[1] : pose.legR[1]);
  return (
    <g>
      {/* Legs: skin at the knee, socks to the boot. */}
      {([0, 1] as const).map((s) => (
        <g key={`leg${s}`}>
          <Segment a={j.hips[s]} b={j.knees[s]} ra={9} rb={7} fill={KIT.skin} light={KIT.skinLight} />
          <Segment a={j.knees[s]} b={j.ankles[s]} ra={7} rb={5} fill={KIT.socks} light={KIT.shirtLight} />
          <path d={capsule(along(j.knees[s], shinAngle(s), 9), along(j.knees[s], shinAngle(s), 11), 7.4, 7)} fill={KIT.shirtDark} />
          <Boot at={j.ankles[s]} angle={shinAngle(s)} />
        </g>
      ))}

      {/* Shorts over the hips and the tops of the thighs, joined at the crotch. */}
      {([0, 1] as const).map((s) => (
        <path key={`short${s}`} d={capsule(j.hips[s], along(j.hips[s], s === 0 ? pose.legL[0] : pose.legR[0], 22), 11.5, 10.5)} fill={KIT.shorts} />
      ))}
      <path
        d={`M${f(body(pose, -24, -6)[0])} ${f(body(pose, -24, -6)[1])} L${f(body(pose, 24, -6)[0])} ${f(body(pose, 24, -6)[1])} L${f(body(pose, 14, 12)[0])} ${f(body(pose, 14, 12)[1])} L${f(body(pose, 0, 16)[0])} ${f(body(pose, 0, 16)[1])} L${f(body(pose, -14, 12)[0])} ${f(body(pose, -14, 12)[1])} Z`}
        fill={KIT.shorts}
      />
      {([0, 1] as const).map((s) => (
        <path key={`hem${s}`} d={capsule(along(j.hips[s], s === 0 ? pose.legL[0] : pose.legR[0], 26), along(j.hips[s], s === 0 ? pose.legL[0] : pose.legR[0], 28), 10.6, 10.4)} fill={KIT.shirt} />
      ))}

      {/* Neck, then the shirt over it. */}
      <Segment a={j.neck} b={j.head} ra={6.5} rb={6.5} fill={KIT.skinDark} />
      <g transform={`translate(${f(pose.pelvis[0])} ${f(pose.pelvis[1])}) rotate(${torsoAngle})`}>
        <path d="M-17 -2 C-19 -20 -23 -36 -27 -47 Q-25 -55 -11 -56 L11 -56 Q25 -55 27 -47 C23 -36 19 -20 17 -2 Q0 4 -17 -2 Z" fill={KIT.shirt} />
        <path d="M-17 -2 C-19 -20 -23 -36 -27 -47 Q-26 -51 -22 -53 C-18 -38 -14 -20 -11 0 Z" fill={KIT.shirtDark} opacity="0.65" />
        <path d="M17 -2 C19 -20 23 -36 27 -47 Q26 -51 22 -53 C18 -38 14 -20 11 0 Z" fill={KIT.shirtDark} opacity="0.4" />
        <path d="M-8 -55 L0 -46 L8 -55" fill="none" stroke={KIT.shorts} strokeWidth="3" strokeLinejoin="round" />
        <path d="M-25 -30 H25 V-24 H-25 Z" fill={KIT.shorts} opacity="0.85" />
        <text x="0" y="-26.2" textAnchor="middle" fontSize="5.4" fontWeight="900" fontFamily="system-ui, sans-serif" fill={KIT.shirt} letterSpacing="0.6">
          BAST.AL
        </text>
        <text x="11" y="-36" textAnchor="middle" fontSize="8" fontWeight="900" fontFamily="system-ui, sans-serif" fill={KIT.shorts}>
          1
        </text>
        <path d="M-13 -40 C-6 -44 -3 -50 -6 -54" fill="none" stroke={KIT.shirtLight} strokeWidth="2" opacity="0.5" />
      </g>

      {/* Arms in long sleeves, and the gloves. */}
      {([0, 1] as const).map((s) => (
        <g key={`arm${s}`}>
          <Segment a={j.shoulders[s]} b={j.elbows[s]} ra={7.5} rb={6.2} fill={KIT.shirt} light={KIT.shirtLight} />
          <Segment a={j.elbows[s]} b={j.wrists[s]} ra={6.2} rb={5.2} fill={KIT.shirt} light={KIT.shirtLight} />
          <path d={capsule(along(j.elbows[s], forearmAngle(s), 3), along(j.elbows[s], forearmAngle(s), 8), 6, 5.6)} fill={KIT.shirtDark} opacity="0.55" />
          <Glove at={j.wrists[s]} angle={forearmAngle(s)} mirror={s === 1} />
        </g>
      ))}

      <KeeperHead at={j.head} angle={pose.head} />
    </g>
  );
}

/** The keeper's head, face on: hair, ears, brows, eyes, nose, mouth and a little shading. */
function KeeperHead({ at, angle }: { at: Point; angle: number }) {
  return (
    <g transform={`translate(${f(at[0])} ${f(at[1])}) rotate(${angle})`}>
      <ellipse cx="-11.5" cy="1" rx="3" ry="4.4" fill={KIT.skinDark} />
      <ellipse cx="11.5" cy="1" rx="3" ry="4.4" fill={KIT.skinDark} />
      <path d="M-11 -4 C-11 -14 -5 -17 0 -17 C5 -17 11 -14 11 -4 L10.5 5 C9 11 4.5 15 0 15 C-4.5 15 -9 11 -10.5 5 Z" fill={KIT.skin} />
      <path d="M-10.5 5 C-9 11 -4.5 15 0 15 C-3.5 12 -7 8 -8.5 2 Z" fill={KIT.skinDark} opacity="0.45" />
      <path d="M-7 -12 C-4 -14 3 -14 7 -11 C4 -12.5 -3 -12.5 -7 -9 Z" fill={KIT.skinLight} opacity="0.5" />
      {/* Short dark hair with a fade at the sides. */}
      <path d="M-11.6 -3 C-13 -15 -5 -20.5 1 -20 C9 -19.5 13.5 -13 11.6 -3 C10.4 -8 8 -11 4 -12.5 C0 -11 -6 -11.5 -9 -9.5 C-10.2 -7.5 -11 -5.5 -11.6 -3 Z" fill={KIT.hair} />
      <path d="M-11.6 -3 L-10.8 2 M11.6 -3 L10.8 2" stroke={KIT.hair} strokeWidth="1.6" opacity="0.55" />
      {/* Brows, eyes, nose, mouth. */}
      <path d="M-8 -5.2 Q-5 -7 -2.2 -5.6 M2.2 -5.6 Q5 -7 8 -5.2" fill="none" stroke={KIT.hair} strokeWidth="1.5" strokeLinecap="round" />
      <ellipse cx="-4.8" cy="-2" rx="2.3" ry="1.5" fill="#fbf6ef" />
      <ellipse cx="4.8" cy="-2" rx="2.3" ry="1.5" fill="#fbf6ef" />
      <circle cx="-4.4" cy="-1.9" r="1.15" fill="#3a2618" />
      <circle cx="5.2" cy="-1.9" r="1.15" fill="#3a2618" />
      <circle cx="-4.1" cy="-2.3" r="0.35" fill="#fff" />
      <circle cx="5.5" cy="-2.3" r="0.35" fill="#fff" />
      <path d="M0 -2 L-1.6 4.4 Q0 5.6 1.8 4.6" fill="none" stroke={KIT.skinDark} strokeWidth="1.1" strokeLinecap="round" />
      <path d="M-3.6 8.6 Q0 10.2 3.6 8.6" fill="none" stroke="#8a4a3c" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M-6 10.5 C-3 13.5 3 13.5 6 10.5" fill="none" stroke={KIT.hair} strokeWidth="0.8" opacity="0.25" />
    </g>
  );
}

/** A big keeper's glove, fingers spread, pointing along the forearm. */
function Glove({ at, angle, mirror }: { at: Point; angle: number; mirror?: boolean }) {
  return (
    <g transform={`translate(${f(at[0])} ${f(at[1])}) rotate(${-angle})${mirror ? " scale(-1 1)" : ""}`}>
      <rect x="-6.2" y="-3" width="12.4" height="6" rx="2" fill="#15181d" />
      <path d="M-7.5 2 C-9 8 -9.5 14 -8 19 C-7 21.5 -4.5 21 -4.2 18.5 L-3.6 13 L-2.8 21.5 C-2.4 24 0.4 24 0.6 21.5 L1 13.5 L2.4 20.6 C2.9 23 5.6 22.6 5.6 20 L5.2 12.5 L7 17.2 C8 19.4 10.4 18.4 9.8 16 L8.4 6 C8 3.5 6 2 3.5 2 Z" fill="#f4f6f2" />
      <path d="M-11 6 C-13.5 7.5 -13.5 12 -11 13.5 L-7.6 12 L-7.4 7 Z" fill="#f4f6f2" />
      <path d="M-7.5 2 H8.6 L8.8 6.5 H-8 Z" fill={KIT.shirt} />
      <path d="M-6 9 C-2 11 3 11 7 9" fill="none" stroke="#c9cdc6" strokeWidth="1" />
    </g>
  );
}

/** A boot with its studs, under the ankle. */
function Boot({ at, angle }: { at: Point; angle: number }) {
  return (
    <g transform={`translate(${f(at[0])} ${f(at[1])}) rotate(${-angle})`}>
      <path d="M-5.5 -2 C-6 3 -6.4 7 -5 9 C-2 10.5 2 10.5 5 9 C6.4 7 6 3 5.5 -2 Z" fill="#101317" />
      <path d="M-5 2.5 H5" stroke={KIT.shirt} strokeWidth="1.6" />
      <path d="M-4 9.6 V11 M0 10.2 V11.6 M4 9.6 V11" stroke="#9aa3ad" strokeWidth="1.3" />
    </g>
  );
}

/* ---------- The penalty taker, seen from behind ---------- */

type TakerPoseName = "stance" | "runA" | "runB" | "plant" | "strike" | "follow" | "watch" | "celebrate" | "dejected";

/**
 * The taker's kick, seen from behind (legL is the leg on the left of the
 * picture, his left). A running stride from behind: one leg straight under
 * him, the other folded up with the sole showing; arms swing against the
 * legs. Then the left foot is planted beside the ball, the right leg drawn
 * back, swung through the ball, and followed through across the body, up and
 * away from the camera (so it looks short).
 */
const TAKER_POSES: Record<TakerPoseName, Pose> = {
  stance: { pelvis: [96, 150], spine: 6, head: 4, armL: [-30, -14], armR: [24, 10], legL: [-12, -4], legR: [18, 12] },
  runA: { pelvis: [100, 152], spine: 3, head: 2, armL: [-14, 176], armR: [30, 14], legL: [-10, 160], legR: [4, 0], len: { armL: 0.72, legL: 0.85 } },
  runB: { pelvis: [100, 152], spine: -3, head: -2, armL: [-30, -14], armR: [14, -176], legL: [-4, 0], legR: [10, -160], len: { armR: 0.72, legR: 0.85 } },
  plant: { pelvis: [96, 156], spine: -12, head: -8, armL: [-82, -100], armR: [48, 26], legL: [-2, 4], legR: [34, 150], len: { legR: 0.86 } },
  strike: { pelvis: [98, 154], spine: -10, head: -6, armL: [-96, -114], armR: [66, 50], legL: [-2, 4], legR: [22, 18] },
  follow: { pelvis: [100, 150], spine: 7, head: 5, armL: [-122, -142], armR: [38, 20], legL: [-4, 2], legR: [-150, -172], len: { legR: 0.42, armL: 0.92 } },
  watch: { pelvis: [98, 150], spine: 2, head: 0, armL: [-18, -8], armR: [18, 8], legL: [-10, -3], legR: [10, 3] },
  // Scored: both arms up, up on his toes.
  celebrate: { pelvis: [98, 146], spine: -3, head: -6, armL: [-152, -166], armR: [148, 162], legL: [-12, -6], legR: [12, 8] },
  // Saved: hands on his head.
  dejected: { pelvis: [98, 152], spine: 4, head: 6, armL: [-132, 96], armR: [132, -96], legL: [-8, -2], legR: [8, 2], len: { armL: 0.9, armR: 0.9 } },
};
const TAKER_ORDER: TakerPoseName[] = ["stance", "runA", "runB", "plant", "strike", "follow", "watch"];
const TAKER_SIZE = { torso: 62, shoulder: 26, hip: 15, upperArm: 30, forearm: 28, thigh: 42, shin: 42, neck: 19 };
const STRIP = { shirt: "#c8102e", shirtDark: "#8e0a20", shorts: "#f4f4f4", socks: "#c8102e", skin: "#c99272", skinDark: "#a6744f", hair: "#2a1d14" };

/**
 * Before the kick he stands set, shifting his weight. The stylesheet then
 * shows each pose of the kick in turn: he celebrates or holds his head, then
 * steps back to his mark (the running poses, backwards) for the next one.
 */
function TakerRig({ kicked, scored }: { kicked: boolean; scored: boolean }) {
  return (
    <>
      <ellipse className="pk-taker-shadow" cx="100" cy="240" rx="40" ry="6" fill="#000" opacity="0.3" />
      {kicked ? (
        [...TAKER_ORDER, scored ? "celebrate" : "dejected"].map((name, i) => (
          <g key={name} className={`pk-tpose is-${i === TAKER_ORDER.length ? "react" : name}`}>
            <TakerFigure name={name as TakerPoseName} />
          </g>
        ))
      ) : (
        <g className="pk-taker-still">
          <TakerFigure name="stance" />
        </g>
      )}
    </>
  );
}

function TakerFigure({ name }: { name: TakerPoseName }) {
  return (
    <Outlined>
      <TakerDrawing name={name} />
    </Outlined>
  );
}

function TakerDrawing({ name }: { name: TakerPoseName }) {
  const p = TAKER_POSES[name];
  const j = joints(p, TAKER_SIZE);
  const shin = (s: 0 | 1) => (s ? p.legR : p.legL)[1];
  const k = (limb: "armL" | "armR" | "legL" | "legR") => p.len?.[limb] ?? 1;
  return (
    <g>
      {([0, 1] as const).map((s) => (
        <g key={s}>
          <Segment a={j.hips[s]} b={j.knees[s]} ra={11} rb={8.5} fill={STRIP.skin} />
          <Segment a={j.knees[s]} b={j.ankles[s]} ra={8} rb={5.6} fill={STRIP.socks} />
          <path d={capsule(along(j.ankles[s], shin(s), -2), along(j.ankles[s], shin(s), 9 * k(s ? "legR" : "legL")), 6.2, 6)} fill="#101317" />
        </g>
      ))}
      {([0, 1] as const).map((s) => (
        <path key={`short${s}`} d={capsule(j.hips[s], along(j.hips[s], (s ? p.legR : p.legL)[0], 18 * k(s ? "legR" : "legL")), 13, 12)} fill={STRIP.shorts} />
      ))}
      <path d={capsule(j.hips[0], j.hips[1], 13, 13)} fill={STRIP.shorts} />
      <Segment a={j.neck} b={j.head} ra={7.5} rb={7.5} fill={STRIP.skinDark} />
      {/* The back of the shirt: number 10 and the name. */}
      <g transform={`translate(${f(p.pelvis[0])} ${f(p.pelvis[1])}) rotate(${p.spine})`}>
        <path d="M-20 -2 C-22 -22 -26 -40 -30 -54 Q-28 -63 -13 -64 L13 -64 Q28 -63 30 -54 C26 -40 22 -22 20 -2 Q0 4 -20 -2 Z" fill={STRIP.shirt} />
        <path d="M-20 -2 C-22 -22 -26 -40 -30 -54 Q-29 -58 -25 -60 C-21 -42 -17 -22 -14 0 Z" fill={STRIP.shirtDark} opacity="0.6" />
        <path d="M-12 -63 Q0 -58 12 -63" fill="none" stroke="#f4f4f4" strokeWidth="2.4" />
        <text x="0" y="-48" textAnchor="middle" fontSize="7" fontWeight="900" fontFamily="system-ui, sans-serif" fill="#f4f4f4" letterSpacing="1.2">
          BAST
        </text>
        <text x="0" y="-16" textAnchor="middle" fontSize="28" fontWeight="900" fontFamily="system-ui, sans-serif" fill="#f4f4f4">
          10
        </text>
      </g>
      {([0, 1] as const).map((s) => (
        <g key={`arm${s}`}>
          <Segment a={j.shoulders[s]} b={j.elbows[s]} ra={8} rb={6.6} fill={STRIP.shirt} />
          <Segment a={j.elbows[s]} b={j.wrists[s]} ra={6} rb={5} fill={STRIP.skin} />
          <circle cx={f(j.wrists[s][0])} cy={f(j.wrists[s][1])} r="5.6" fill={STRIP.skin} />
          <path d={capsule(j.shoulders[s], along(j.shoulders[s], (s ? p.armR : p.armL)[0], 16 * k(s ? "armR" : "armL")), 8.6, 7.6)} fill={STRIP.shirt} />
        </g>
      ))}
      {/* The back of the head: hair, ears. */}
      <g transform={`translate(${f(j.head[0])} ${f(j.head[1])}) rotate(${p.head})`}>
        <ellipse cx="-12.4" cy="1" rx="3" ry="4.6" fill={STRIP.skinDark} />
        <ellipse cx="12.4" cy="1" rx="3" ry="4.6" fill={STRIP.skinDark} />
        <ellipse cx="0" cy="-1" rx="12.6" ry="15" fill={STRIP.hair} />
        <path d="M-10 6 C-6 13 6 13 10 6 C8 10 -8 10 -10 6 Z" fill={STRIP.skinDark} opacity="0.6" />
        <path d="M-6 -10 C-2 -13 4 -12 7 -9" fill="none" stroke="#4a3626" strokeWidth="1.6" opacity="0.7" />
      </g>
    </g>
  );
}

/* ---------- The ball ---------- */

function Ball() {
  return (
    <svg viewBox="0 0 64 64">
      <BallArt id="flying" />
    </svg>
  );
}

/** The ball's picture in a 64-unit box. `id` keeps its gradient and clip apart from another ball's on the page. */
function BallArt({ id }: { id: string }) {
  return (
    <>
      <defs>
        <radialGradient id={`pk-ball-shade-${id}`} cx="34%" cy="30%" r="74%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#eef2f5" />
          <stop offset="100%" stopColor="#aeb8c4" />
        </radialGradient>
        <clipPath id={`pk-ball-clip-${id}`}>
          <circle cx="32" cy="32" r="30" />
        </clipPath>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#pk-ball-shade-${id})`} />
      <g clipPath={`url(#pk-ball-clip-${id})`} className="pk-ball-panels">
        <polygon points="32,21 41.5,28 38,39 26,39 22.5,28" fill="#16181c" />
        <polygon points="32,0 40,6 32,12 24,6" fill="#16181c" />
        <polygon points="56,22 64,30 58,40 50,33" fill="#16181c" />
        <polygon points="8,22 14,33 6,40 0,30" fill="#16181c" />
        <polygon points="18,52 26,48 30,58 20,64" fill="#16181c" />
        <polygon points="46,52 38,48 34,58 44,64" fill="#16181c" />
        <path d="M32 12 V21 M41.5 28 L50 33 M22.5 28 L14 33 M38 39 L38 48 M26 39 L26 48" stroke="#9aa3ad" strokeWidth="0.8" />
      </g>
      <circle cx="32" cy="32" r="30" fill="none" stroke="#8a95a2" strokeWidth="1" />
      <ellipse cx="23" cy="19" rx="8" ry="5" fill="#fff" opacity="0.7" />
    </>
  );
}
