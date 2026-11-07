/**
 * Candy Cascade's candies: paying symbols and the lollipop use PNG/WebP artwork;
 * the multiplier bomb stays as an SVG <symbol>, shown with <use>.
 */
import type { CandyCell } from "../lib/api";

const ART: Record<string, string> = {
  HEART: "/casino/candy/heart.webp",
  STAR: "/casino/candy/star.webp",
  MOON: "/casino/candy/moon.webp",
  GEM: "/casino/candy/gem.webp",
  ORANGE: "/casino/candy/orange.webp",
  LEMON: "/casino/candy/lemon.webp",
  MINT: "/casino/candy/mint.webp",
  GRAPE: "/casino/candy/grape.webp",
  PEACH: "/casino/candy/peach.webp",
  LOLLIPOP: "/casino/candy/lollipop.webp",
};

/** Multiplier bomb as an SVG <symbol>, once per page. Paying candies are images. */
export function CandyDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="cc-bomb" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#fff3b0" />
          <stop offset="0.5" stopColor="#ffb21f" />
          <stop offset="1" stopColor="#e2401f" />
        </radialGradient>
        <filter id="cc-shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="3" stdDeviation="2.5" floodColor="#3a0a3a" floodOpacity="0.45" />
        </filter>
        <symbol id="candy-X" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <circle cx="50" cy="52" r="38" fill="url(#cc-bomb)" stroke="#9c1f0a" strokeWidth="3" />
            {Array.from({ length: 12 }, (_, i) => (
              <path key={i} d="M50 14 L54 22 L46 22Z" fill="#fff7c2" transform={`rotate(${i * 30} 50 52)`} opacity="0.85" />
            ))}
            <ellipse cx="36" cy="34" rx="11" ry="6" fill="#fff" opacity="0.5" transform="rotate(-25 36 34)" />
          </g>
        </symbol>
      </defs>
    </svg>
  );
}

/** One candy. A multiplier candy shows its value on the bomb art. */
export function CandyIcon({ cell, className }: { cell: CandyCell; className?: string }) {
  const multiplier = cell.startsWith("X") ? cell.slice(1) : null;
  const art = multiplier ? null : ART[cell];
  return (
    <svg className={`candy-icon${multiplier ? " is-multiplier" : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 100 100" aria-hidden="true">
      {art ? <image href={art} x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" /> : <use href="#candy-X" />}
      {multiplier ? (
        <text x="50" y="58" textAnchor="middle" dominantBaseline="middle" className="candy-multiplier-text" fontSize={multiplier.length > 2 ? 26 : 32}>
          {multiplier}×
        </text>
      ) : null}
    </svg>
  );
}

/** Each candy's name, for the rules and for screen readers. */
export const CANDY_NAMES: Record<string, string> = {
  HEART: "Heart",
  STAR: "Star",
  MOON: "Moon",
  GEM: "Gem",
  ORANGE: "Apple",
  LEMON: "Banana",
  MINT: "Watermelon",
  GRAPE: "Grapes",
  PEACH: "Plum",
  LOLLIPOP: "Lollipop",
};
