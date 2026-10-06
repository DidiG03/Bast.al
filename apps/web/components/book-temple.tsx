/**
 * Book of Ra's temple, after the original: the dark carved stone wall behind
 * the reels and the buttons, and a column each side of the reels, behind the
 * numbered boxes. Drawn here in SVG, with no image files: the stone's grain
 * is a tile of lit noise made once in the browser (book-textures; SVG noise
 * filters were slow to redraw), and the hieroglyphs are cut into it (a
 * shadow on their upper edge, light on the lower). BookTempleDefs holds what
 * the wall, the columns and the reels' backdrop share, once on the page.
 */

import { memo, useEffect, useState } from "react";
import { useTexture } from "./book-textures";

/** The hieroglyphs, each in a 30 × 36 box, drawn as lines. */
const GLYPHS: Record<string, string> = {
  ankh: "M15 3a5 6 0 1 1-.1 0z M15 15v18 M8 17h14",
  eye: "M3 15q12-10 24 0q-12 8-24 0z M12 15a3 3 0 1 0 6 0a3 3 0 1 0-6 0 M12 21l-3 9 M18 21q3 7 9 5",
  water: "M2 14l4-4l4 4l4-4l4 4l4-4l4 4l4-4 M2 24l4-4l4 4l4-4l4 4l4-4l4 4l4-4",
  reed: "M15 34V12q-7-2-5-9q9 2 5 9 M11 20q4 2 8 0",
  ibis: "M7 31l5-6q-3-10 5-13l3-7l3 2l-2 4q5 8-3 14l3 6 M13 25l-2 9 M18 25l2 9",
  seated: "M11 4a4 4 0 1 1-.1 0z M11 12v11h10v11 M11 18h7 M11 23l-4 10",
  snake: "M3 31q6-8 12 0t12 0 M27 31v-12q0-5-5-5l-3 2",
  sun: "M8 17a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M4 29h22 M15 10v-6",
  djed: "M11 34V7h8v27 M7 11h16 M7 16h16 M7 21h16",
  owl: "M8 33V15q0-9 7-9q7 0 7 9v18 M12 13h.1 M18 13h.1 M8 33h14",
  feather: "M15 34V4q7 9 0 30 M15 12l4-3 M15 19l5-3",
  bowl: "M4 20q11 13 22 0z M8 14h14",
  hand: "M4 22h16q6 0 6-4q0-3-4-3h-6 M8 22v-6h8 M10 16v-4",
  bread: "M6 28q0-14 9-14q9 0 9 14z",
  scarab: "M15 9a4 3 0 1 1-.1 0z M15 12a7 9 0 1 1-.1 0z M15 12v17 M8 16l-5-3 M22 16l5-3 M8 25l-5 3 M22 25l5 3",
  lotus: "M15 34V20 M15 20q-9-2-9-12q6 2 9 12q3-10 9-12q0 10-9 12 M15 20q-2-8 0-14q2 6 0 14",
};

const NAMES = Object.keys(GLYPHS);

/** Glyph names in a row of `count`, starting `offset` into the list, so neighbouring rows differ. */
const row = (count: number, offset: number) => Array.from({ length: count }, (_, i) => NAMES[(i * 5 + offset) % NAMES.length]);

/** A hieroglyph cut into stone at (x, y), `w` wide: light along its lower edge, shadow in the cut; `depth` from 0 (faint) to 1. */
function Carved({ name, x, y, w, depth = 1 }: { name: string; x: number; y: number; w: number; depth?: number }) {
  const h = (w * 36) / 30;
  return (
    <>
      <use href={`#bk-glyph-${name}`} x={x + w * 0.05} y={y + w * 0.06} width={w} height={h} stroke="#d9a464" strokeOpacity={0.14 * depth} />
      <use href={`#bk-glyph-${name}`} x={x} y={y} width={w} height={h} stroke="#000" strokeOpacity={0.6 * depth} />
    </>
  );
}

/** Shared by the wall, the columns and the reels' backdrop: the glyphs, the stone's grain and the column's shading. Render once. */
function TempleDefs() {
  const stone = useTexture("stone");
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        {Object.entries(GLYPHS).map(([name, d]) => (
          <symbol key={name} id={`bk-glyph-${name}`} viewBox="0 0 30 36" overflow="visible">
            <path d={d} fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </symbol>
        ))}
        {/* Rough stone, lit from the top left, in warm brown: a tile made once (book-textures), repeated. */}
        <pattern id="bk-grain" patternUnits="userSpaceOnUse" width="256" height="256">
          {stone ? <image href={stone} width="256" height="256" /> : null}
        </pattern>
        <radialGradient id="bk-vignette" cx="0.5" cy="0.55" r="0.75">
          <stop offset="0.35" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.92" />
        </radialGradient>
        <radialGradient id="bk-lamp" cx="0.5" cy="1.08" r="0.62" gradientTransform="translate(0.5 1.08) scale(1.6 1) translate(-0.5 -1.08)">
          <stop offset="0" stopColor="#ff9a3a" stopOpacity="0.5" />
          <stop offset="0.45" stopColor="#c0561a" stopOpacity="0.18" />
          <stop offset="1" stopColor="#c0561a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="bk-lamp-up" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="#ff9a3a" stopOpacity="0" />
          <stop offset="1" stopColor="#ff9a3a" stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id="bk-cylinder" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.85" />
          <stop offset="0.25" stopColor="#000" stopOpacity="0.35" />
          <stop offset="0.45" stopColor="#ffd9a0" stopOpacity="0.12" />
          <stop offset="0.6" stopColor="#000" stopOpacity="0.1" />
          <stop offset="1" stopColor="#000" stopOpacity="0.9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** A recessed panel of carved hieroglyphs: shadow on its top and left inner edges, light on the bottom and right. */
function Panel({ x, y, w, h, rows, seed, glyph = 26 }: { x: number; y: number; w: number; h: number; rows: number; seed: number; glyph?: number }) {
  const across = Math.max(1, Math.floor((w - 20) / (glyph * 1.4)));
  const step = (w - 20 - glyph) / Math.max(1, across - 1);
  const down = (h - 20 - glyph * 1.2) / Math.max(1, rows - 1);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="#000" fillOpacity="0.16" />
      <path d={`M${x} ${y + h}V${y}H${x + w}`} fill="none" stroke="#000" strokeOpacity="0.6" strokeWidth="3" />
      <path d={`M${x + w} ${y}V${y + h}H${x}`} fill="none" stroke="#e0aa6a" strokeOpacity="0.14" strokeWidth="2" />
      {Array.from({ length: rows }, (_, r) =>
        row(across, seed + r * 3).map((name, i) => <Carved key={`${r}:${i}`} name={name} x={x + 10 + i * step} y={y + 10 + r * down} w={glyph} depth={0.4} />),
      )}
    </g>
  );
}

/** The temple wall: big carved panels in rough stone, darker towards the edges. Fills its box. */
function Wall() {
  // Laid out on a fixed 1600 × 900 wall, cut to the box's shape from the middle.
  return (
    <svg className="book-wall" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="1600" height="900" fill="#050201" />
      <rect width="1600" height="900" fill="url(#bk-grain)" opacity="0.2" />
      {[0, 1, 2, 3].map((column) =>
        [0, 1].map((band) => (
          <Panel key={`${column}:${band}`} x={30 + column * 395} y={36 + band * 430} w={365} h={400} rows={4} seed={column * 4 + band * 7} glyph={56} />
        )),
      )}
      <rect width="1600" height="900" fill="#c06a1c" opacity="0.18" style={{ mixBlendMode: "overlay" }} />
      <rect width="1600" height="900" fill="url(#bk-vignette)" />
      {/* A warm light from below. */}
      <rect width="1600" height="900" fill="url(#bk-lamp)" />
    </svg>
  );
}

/**
 * Where the reels sit in the hall, kept up to date as either is resized:
 * sets --book-reels-left, -top, -width and -height on the hall, in pixels,
 * so the columns can stand either side of the reels, the buttons between
 * them, and START and TOTAL BET over the right-hand numbers. Pass `hall` and `reels` to those elements as refs.
 */
export function useHallLayout() {
  const [hall, setHall] = useState<HTMLDivElement | null>(null);
  const [reels, setReels] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hall || !reels) return;
    const place = () => {
      const outer = hall.getBoundingClientRect();
      const inner = reels.getBoundingClientRect();
      hall.style.setProperty("--book-reels-left", `${inner.left - outer.left}px`);
      hall.style.setProperty("--book-reels-width", `${inner.width}px`);
      hall.style.setProperty("--book-reels-top", `${inner.top - outer.top}px`);
      hall.style.setProperty("--book-reels-height", `${inner.height}px`);
      hall.dataset.placed = "";
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(hall);
    watch.observe(reels);
    return () => watch.disconnect();
  }, [hall, reels]);
  return { hall: setHall, reels: setReels };
}

/**
 * A temple column: a papyrus capital on top, a round shaft carved with a
 * column of hieroglyphs and bound with bands near its foot, and a plinth.
 */
function Column({ side }: { side: "left" | "right" }) {
  return (
    <div className={`book-column is-${side}`} aria-hidden="true">
      <svg className="book-column-capital" viewBox="0 0 100 92">
        <rect x="0" y="0" width="100" height="14" fill="#3a2410" />
        <rect x="0" y="0" width="100" height="14" fill="url(#bk-grain)" opacity="0.8" />
        <path d="M0 14H100" stroke="#e0aa6a" strokeOpacity="0.3" strokeWidth="1.5" />
        <path d="M2 14C10 40 26 60 34 74H66C74 60 90 40 98 14Z" fill="#3a2410" />
        <path d="M2 14C10 40 26 60 34 74H66C74 60 90 40 98 14Z" fill="url(#bk-grain)" opacity="0.85" />
        {/* The papyrus stalks, then the cylinder's shading. */}
        {[14, 26, 38, 50, 62, 74, 86].map((x) => (
          <path key={x} d={`M${x} 16Q${50 + (x - 50) * 0.55} 50 ${50 + (x - 50) * 0.32} 73`} fill="none" stroke="#000" strokeOpacity="0.5" strokeWidth="2" />
        ))}
        <path d="M2 14C10 40 26 60 34 74H66C74 60 90 40 98 14Z" fill="url(#bk-cylinder)" />
        {[76, 81, 86].map((y) => (
          <g key={y}>
            <rect x="32" y={y} width="36" height="4" fill="#2e1c0c" />
            <rect x="32" y={y} width="36" height="4" fill="url(#bk-cylinder)" />
            <path d={`M32 ${y + 4}H68`} stroke="#000" strokeOpacity="0.6" strokeWidth="1" />
          </g>
        ))}
      </svg>
      <svg className="book-column-shaft" viewBox="0 0 100 1400" preserveAspectRatio="xMidYMax slice">
        <rect x="18" y="0" width="64" height="1330" fill="#33200e" />
        <rect x="18" y="0" width="64" height="1330" fill="url(#bk-grain)" opacity="0.9" />
        {/* The carved strip down the front. */}
        <rect x="35" y="0" width="30" height="1150" fill="#000" fillOpacity="0.2" />
        <path d="M35 0V1150" stroke="#000" strokeOpacity="0.6" strokeWidth="2" />
        <path d="M65 0V1150" stroke="#e0aa6a" strokeOpacity="0.15" strokeWidth="1.5" />
        {Array.from({ length: 30 }, (_, i) => (
          <Carved key={i} name={NAMES[(i * 7) % NAMES.length]} x={38} y={1112 - i * 38} w={24} />
        ))}
        {/* Bands round the foot. */}
        {[1170, 1190, 1210, 1260, 1280].map((y) => (
          <path key={y} d={`M18 ${y}Q50 ${y + 8} 82 ${y}`} fill="none" stroke="#000" strokeOpacity="0.55" strokeWidth="5" />
        ))}
        {[1166, 1186, 1206, 1256, 1276].map((y) => (
          <path key={y} d={`M18 ${y}Q50 ${y + 8} 82 ${y}`} fill="none" stroke="#e0aa6a" strokeOpacity="0.16" strokeWidth="2" />
        ))}
        <Carved name="ankh" x={38} y={1222} w={24} />
        <rect x="18" y="0" width="64" height="1330" fill="url(#bk-cylinder)" />
        <rect x="4" y="0" width="92" height="1400" fill="url(#bk-lamp-up)" style={{ mixBlendMode: "overlay" }} />
        {/* The plinth. */}
        <rect x="4" y="1330" width="92" height="70" fill="#2e1c0c" />
        <rect x="4" y="1330" width="92" height="70" fill="url(#bk-grain)" opacity="0.85" />
        <path d="M4 1331H96" stroke="#e0aa6a" strokeOpacity="0.3" strokeWidth="2" />
        <rect x="4" y="1330" width="92" height="70" fill="url(#bk-cylinder)" opacity="0.6" />
      </svg>
    </div>
  );
}

/**
 * Behind the reels: each reel a dark stone panel carved with hieroglyphs, and
 * between them the red, turquoise and gold Egyptian bands. Drawn to the
 * reels' own measures (128 pixels a cell, 10 between reels), so the bands
 * sit exactly in the gaps.
 */
function Backdrop({ reels, rows }: { reels: number; rows: number }) {
  const cell = 128;
  const gap = 10;
  const width = reels * cell + (reels - 1) * gap;
  const height = rows * cell;
  return (
    <svg className="book-backdrop" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="book-stone" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
        {/* Each row darker at its top, lighter towards its bottom, like the symbols on it. */}
        <linearGradient id="book-row-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity="0.35" />
          <stop offset="0.6" stopColor="#000" stopOpacity="0.08" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <pattern id="book-band" width={gap} height="24" patternUnits="userSpaceOnUse">
          <rect width={gap} height="24" fill="#b51d14" />
          <rect y="8" width={gap} height="8" fill="#1fa596" />
          <rect y="7" width={gap} height="1.5" fill="#f3c64b" />
          <rect y="15.5" width={gap} height="1.5" fill="#f3c64b" />
        </pattern>
      </defs>
      {Array.from({ length: reels }, (_, reel) => (
        <g key={reel} transform={`translate(${reel * (cell + gap)} 0)`}>
          <rect width={cell} height={height} fill="#2e1b0b" />
          <rect width={cell} height={height} fill="url(#bk-grain)" opacity="0.75" />
          {/* Rows of hieroglyphs between carved lines, deep enough to catch the light. */}
          {Array.from({ length: rows * 3 }, (_, line) => (
            <g key={line}>
              <path d={`M4 ${2 + line * 44}H124`} stroke="#000" strokeOpacity="0.5" strokeWidth="1.6" />
              <path d={`M4 ${3.6 + line * 44}H124`} stroke="#e0aa6a" strokeOpacity="0.14" strokeWidth="1" />
              {row(3, reel * 3 + line).map((name, i) => (
                <Carved key={i} name={name} x={12 + i * 40} y={8 + line * 44} w={26} depth={0.85} />
              ))}
            </g>
          ))}
          <rect width={cell} height={height} fill="#c06a1c" opacity="0.3" style={{ mixBlendMode: "overlay" }} />
          <rect width={cell} height={height} fill="url(#book-stone)" />
          {Array.from({ length: rows }, (_, r) => (
            <rect key={r} y={r * cell} width={cell} height={cell} fill="url(#book-row-shade)" />
          ))}
        </g>
      ))}
      {Array.from({ length: reels - 1 }, (_, index) => (
        <rect key={index} x={(index + 1) * cell + index * gap} width={gap} height={height} fill="url(#book-band)" />
      ))}
    </svg>
  );
}

// Drawn once: none of these change while the game plays, so the game's frequent updates (a win counting up, say) skip them.
export const BookTempleDefs = memo(TempleDefs);
export const BookWall = memo(Wall);
export const BookColumn = memo(Column);
export const ReelBackdrop = memo(Backdrop);
