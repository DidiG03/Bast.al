"use client";

/**
 * The top of Book of Ra's cabinet, after the original: a stormy desert
 * sunset with palms and pyramids, and the title on a gold winged scarab —
 * big "BOOK OF RA" letters in blue marble with gold edges, a red sun for the
 * O of "of", and "deluxe" beneath. The wings run the whole width, rows of
 * slanting feathers between gold bands, their ends rounded and turned up.
 * Drawn here in SVG with no filters (they were slow to redraw); the marble is
 * a tile made once in the browser. The sky fills the bar; the title keeps its
 * shape in the middle.
 */

import { memo } from "react";
import { useTexture } from "./book-textures";

type Point = [number, number];

/** A point on a cubic Bézier curve at `t`. */
function bezier([a, b, c, d]: Point[], t: number): Point {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t * t * t * d[k]) as Point;
}

/**
 * The left wing's top and bottom edges, from the middle (t = 0) out to its
 * end (t = 1), in the title's 600 × 120 box. The bottom runs nearly level
 * and sweeps up into the wing's broad, rounded end.
 */
const TOP: Point[] = [
  [300, 34],
  [180, 30],
  [70, 22],
  [12, 5],
];
const BOTTOM: Point[] = [
  [300, 114],
  [170, 114],
  [50, 106],
  [8, 62],
];

/** A point `depth` of the way down the wing (0 its top edge, 1 its bottom) at `t` along it. */
function across(t: number, depth: number): Point {
  const [tx, ty] = bezier(TOP, t);
  const [bx, by] = bezier(BOTTOM, t);
  return [tx + (bx - tx) * depth, ty + (by - ty) * depth];
}

/** A row of feathers along the wing, between two depths. */
type FeatherRow = { from: number; to: number; count: number; width: number; fill: string };

const ROWS: FeatherRow[] = [
  { from: 0.05, to: 0.3, count: 20, width: 11, fill: "url(#bm-teal)" },
  { from: 0.36, to: 0.6, count: 20, width: 11.5, fill: "url(#bm-teal)" },
  { from: 0.64, to: 0.97, count: 22, width: 12, fill: "url(#bm-violet)" },
];

/** The feathers of the left wing, worked out once: each slants down and out towards the wing's end. */
const FEATHERS = ROWS.flatMap(({ from, to, count, width, fill }) =>
  Array.from({ length: count }, (_, i) => {
    const t = 0.02 + (0.95 * (i + 0.5)) / count;
    const [x, y] = across(t, from);
    const [x1, y1] = across(t, to);
    const length = Math.hypot(x1 - x, y1 - y) * 1.12;
    const angle = (Math.atan2(y1 - y, x1 - x) * 180) / Math.PI - 90 + 38;
    return { x, y, angle, w: width, h: Math.max(5, length), fill };
  }),
);

/** A gold band along the wing at one depth, as a path. */
const band = (depth: number) =>
  Array.from({ length: 41 }, (_, i) => across(i / 40, depth))
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");

/** The wing's outline: along the top to its end, round the broad turned-up end, and back along the bottom. */
const WING = `M${TOP[0].join(" ")} C${TOP[1].join(" ")} ${TOP[2].join(" ")} ${TOP[3].join(" ")} C2 14 0 40 ${BOTTOM[3].join(" ")} C${BOTTOM[2].join(" ")} ${BOTTOM[1].join(" ")} ${BOTTOM[0].join(" ")} Z`;

/** One wing (the left; the right is it mirrored): feathers set in gold, gold bands between the rows, a bevelled gold rim. */
function Wing() {
  return (
    <g>
      <path d={WING} fill="#000" opacity="0.45" transform="translate(0 3)" />
      <path d={WING} fill="url(#bm-gold)" />
      <g clipPath="url(#bm-wing)">
        {FEATHERS.map(({ x, y, angle, w, h, fill }, index) => (
          <g key={index} transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})`}>
            <path
              d={`M${-w / 2} 0 L${-w / 2} ${h * 0.72} Q${-w / 2} ${h} 0 ${h} Q${w / 2} ${h} ${w / 2} ${h * 0.72} L${w / 2} 0 Z`}
              fill={fill}
              stroke="#e0b040"
              strokeWidth="1"
            />
            <path d={`M0 ${h * 0.08}V${h * 0.86}`} stroke="#000" strokeOpacity="0.35" strokeWidth="0.7" />
          </g>
        ))}
        {[0.33, 0.62].map((depth) => (
          <g key={depth}>
            <path d={band(depth)} fill="none" stroke="#5a3a08" strokeWidth="4.6" />
            <path d={band(depth)} fill="none" stroke="url(#bm-gold)" strokeWidth="3.2" />
          </g>
        ))}
      </g>
      {/* The rim: dark outside, gold, a lit inner edge. */}
      <path d={WING} fill="none" stroke="#3a2204" strokeWidth="6" />
      <path d={WING} fill="none" stroke="url(#bm-gold)" strokeWidth="4" />
      <path d={WING} fill="none" stroke="#fff6c0" strokeOpacity="0.55" strokeWidth="1" />
    </g>
  );
}

/** A word of the title: a shadow, a dark edge, a thin bevelled gold rim, the blue marble face and a gloss over its top. */
function Word({ text, x, width, marble }: { text: string; x: number; width: number; marble: boolean }) {
  const common = { x, y: 101, textLength: width, lengthAdjust: "spacingAndGlyphs" as const };
  return (
    <g>
      <text {...common} transform="translate(0 4)" stroke="#000" strokeOpacity="0.5" strokeWidth="19" strokeLinejoin="round">
        {text}
      </text>
      <text {...common} stroke="#1e1002" strokeWidth="19" strokeLinejoin="round">
        {text}
      </text>
      <text {...common} transform="translate(-1 -1.3)" stroke="#fff6c0" strokeWidth="14.5" strokeLinejoin="round">
        {text}
      </text>
      <text {...common} transform="translate(1 1.3)" stroke="#6a4206" strokeWidth="14.5" strokeLinejoin="round">
        {text}
      </text>
      <text {...common} stroke="url(#bm-gold)" strokeWidth="13" strokeLinejoin="round">
        {text}
      </text>
      {/* The face, outlined in its own marble to make the letters heavier, as the original's are. */}
      <text {...common} fill={marble ? "url(#bm-marble)" : "#1a6ad8"} stroke={marble ? "url(#bm-marble)" : "#1a6ad8"} strokeWidth="3.5" strokeLinejoin="round">
        {text}
      </text>
      <text {...common} fill="url(#bm-gloss)" stroke="url(#bm-gloss)" strokeWidth="3.5" strokeLinejoin="round">
        {text}
      </text>
    </g>
  );
}

function Marquee() {
  const marble = useTexture("marble");
  return (
    <>
      <svg className="book-marquee-art" viewBox="0 0 1000 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="bm-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3a0604" />
            <stop offset="0.35" stopColor="#8a1408" />
            <stop offset="0.7" stopColor="#e0501a" />
            <stop offset="0.92" stopColor="#ffa040" />
            <stop offset="1" stopColor="#ffd070" />
          </linearGradient>
          <radialGradient id="bm-sun" cx="0.5" cy="1" r="0.5">
            <stop offset="0" stopColor="#fff0a0" stopOpacity="0.95" />
            <stop offset="0.4" stopColor="#ffb040" stopOpacity="0.5" />
            <stop offset="1" stopColor="#ff8020" stopOpacity="0" />
          </radialGradient>
          {/* Soft-edged streaks of cloud: each colour fading out to its edge. */}
          {[
            ["bm-cloud-dark", "#4a0604"],
            ["bm-cloud-red", "#c02a10"],
            ["bm-cloud-lit", "#ff8a3a"],
          ].map(([id, color]) => (
            <radialGradient key={id} id={id}>
              <stop offset="0" stopColor={color} stopOpacity="0.75" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </radialGradient>
          ))}
          <linearGradient id="bm-pyramid-lit" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e8602a" />
            <stop offset="1" stopColor="#7a1a08" />
          </linearGradient>
        </defs>
        <rect width="1000" height="120" fill="url(#bm-sky)" />
        {(
          [
            [120, 18, 170, 8, "dark"],
            [420, 12, 230, 7, "dark"],
            [820, 22, 210, 9, "dark"],
            [260, 40, 190, 7, "red"],
            [700, 46, 250, 8, "red"],
            [80, 62, 150, 6, "lit"],
            [560, 70, 210, 6, "lit"],
            [900, 66, 130, 6, "lit"],
          ] as const
        ).map(([x, y, rx, ry, tone], index) => (
          <ellipse key={index} cx={x} cy={y} rx={rx} ry={ry} fill={`url(#bm-cloud-${tone})`} />
        ))}
        <ellipse cx="760" cy="112" rx="260" ry="70" fill="url(#bm-sun)" />
        <ellipse cx="500" cy="118" rx="300" ry="40" fill="url(#bm-sun)" opacity="0.6" />
        {/* Palms on the left. */}
        <g fill="#1c0603">
          <path d="M70 106 L73 76 L76 106 Z M73 76 C62 70 54 73 50 79 C58 74 66 75 73 76 C66 66 58 66 52 69 C61 66 68 70 73 76 C76 65 84 63 92 65 C84 67 78 71 73 76 C83 71 92 72 98 78 C90 74 81 74 73 76 Z" />
          <path d="M142 106 L144 84 L146 106 Z M144 84 C135 80 129 82 125 86 C133 82 139 83 144 84 C150 77 158 77 164 81 C156 80 150 81 144 84 Z" />
        </g>
        {/* Pyramids on the right: a lit face and a shadowed one. */}
        <path d="M790 106 L850 62 L870 106 Z" fill="url(#bm-pyramid-lit)" />
        <path d="M850 62 L910 106 L870 106 Z" fill="#3a0a04" />
        <path d="M880 106 L940 54 L962 106 Z" fill="url(#bm-pyramid-lit)" />
        <path d="M940 54 L1010 106 L962 106 Z" fill="#3a0a04" />
        {/* Dunes. */}
        <path d="M0 106 C150 98 320 104 500 101 C680 98 820 104 1000 103 L1000 120 L0 120 Z" fill="#1c0603" />
      </svg>

      <svg className="book-marquee-logo" viewBox="0 0 600 120" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <linearGradient id="bm-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff6c0" />
            <stop offset="0.3" stopColor="#f6cf5a" />
            <stop offset="0.65" stopColor="#b8801e" />
            <stop offset="1" stopColor="#f0c050" />
          </linearGradient>
          <linearGradient id="bm-teal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4ac0b0" />
            <stop offset="0.5" stopColor="#127a7a" />
            <stop offset="1" stopColor="#06303a" />
          </linearGradient>
          <linearGradient id="bm-violet" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6a5ab8" />
            <stop offset="0.5" stopColor="#2a2068" />
            <stop offset="1" stopColor="#0e0a2a" />
          </linearGradient>
          <linearGradient id="bm-gloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.3" stopColor="#fff" stopOpacity="0.22" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="bm-ruby" cx="0.38" cy="0.32" r="0.72">
            <stop offset="0" stopColor="#ffb08a" />
            <stop offset="0.3" stopColor="#f0401a" />
            <stop offset="0.78" stopColor="#b01404" />
            <stop offset="1" stopColor="#5a0400" />
          </radialGradient>
          <radialGradient id="bm-scarab" cx="0.4" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#fff6c0" />
            <stop offset="0.45" stopColor="#e0a63a" />
            <stop offset="1" stopColor="#6a3c08" />
          </radialGradient>
          <clipPath id="bm-wing">
            <path d={WING} />
          </clipPath>
          <pattern id="bm-marble" patternUnits="userSpaceOnUse" width="80" height="80">
            {marble ? <image href={marble} width="80" height="80" /> : null}
          </pattern>
        </defs>

        <Wing />
        <g transform="translate(600 0) scale(-1 1)">
          <Wing />
        </g>

        {/* The gold scarab at the middle, its back showing above and between the words. */}
        <ellipse cx="300" cy="86" rx="48" ry="30" fill="#000" opacity="0.4" transform="translate(0 3)" />
        <ellipse cx="300" cy="86" rx="48" ry="30" fill="url(#bm-scarab)" stroke="#3a2204" strokeWidth="2" />
        <ellipse cx="300" cy="44" rx="36" ry="20" fill="url(#bm-scarab)" stroke="#3a2204" strokeWidth="2" />
        <path d="M300 58V114 M264 44Q300 30 336 44" fill="none" stroke="#3a2204" strokeWidth="2" />

        <g fontFamily="'Arial Rounded MT Bold', 'Arial Black', 'Helvetica Neue', Arial, sans-serif" fontWeight="900" fontSize="100">
          <Word text="BOOK" x={92} width={204} marble={marble !== null} />
          <Word text="F" x={362} width={54} marble={marble !== null} />
          <Word text="RA" x={424} width={128} marble={marble !== null} />
        </g>

        {/* The red sun for the O of "of". */}
        <circle cx="330" cy="68" r="30" fill="#000" opacity="0.45" transform="translate(0 3)" />
        <circle cx="330" cy="68" r="30" fill="url(#bm-ruby)" stroke="#2a0a02" strokeWidth="2.5" />
        <ellipse cx="320" cy="56" rx="11" ry="6.5" fill="#fff" opacity="0.35" transform="rotate(-28 320 56)" />

        <text
          x="470"
          y="116"
          transform="rotate(-10 470 116)"
          fontFamily="'Arial Black', 'Helvetica Neue', Arial, sans-serif"
          fontStyle="italic"
          fontWeight="900"
          fontSize="25"
          fill="#fff"
          stroke="#1a1a2a"
          strokeWidth="4.5"
          paintOrder="stroke"
        >
          deluxe
        </text>
      </svg>
    </>
  );
}

/** Drawn once: nothing in it changes while the game plays. */
export const BookMarquee = memo(Marquee);
