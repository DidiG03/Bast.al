/**
 * Candy Cascade's candies, drawn here (Shtatat.al's own artwork): each one an
 * SVG symbol defined once on the page (<CandyDefs />) and shown with <use>.
 */
import type { CandyCell } from "../lib/api";

const GLOSS = <ellipse cx="38" cy="30" rx="16" ry="9" fill="#fff" opacity="0.45" transform="rotate(-25 38 30)" />;

/** Every candy as an SVG <symbol>, once per page: 100 by 100, with a soft shadow under it. */
export function CandyDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="cc-heart" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ff8aa3" />
          <stop offset="0.55" stopColor="#f0193f" />
          <stop offset="1" stopColor="#a30020" />
        </radialGradient>
        <radialGradient id="cc-star" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#e6b3ff" />
          <stop offset="0.55" stopColor="#9b3ff0" />
          <stop offset="1" stopColor="#5a14a8" />
        </radialGradient>
        <radialGradient id="cc-moon" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#b9ffb0" />
          <stop offset="0.55" stopColor="#2fcf4d" />
          <stop offset="1" stopColor="#11802a" />
        </radialGradient>
        <linearGradient id="cc-gem" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#bfeaff" />
          <stop offset="0.5" stopColor="#2b9cf2" />
          <stop offset="1" stopColor="#0b4fa8" />
        </linearGradient>
        <radialGradient id="cc-orange" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ffd8a0" />
          <stop offset="0.55" stopColor="#ff8a1f" />
          <stop offset="1" stopColor="#c44f00" />
        </radialGradient>
        <linearGradient id="cc-lemon" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff6a8" />
          <stop offset="0.55" stopColor="#ffd61f" />
          <stop offset="1" stopColor="#d39a00" />
        </linearGradient>
        <radialGradient id="cc-mint" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#d7fff6" />
          <stop offset="1" stopColor="#7fe3cf" />
        </radialGradient>
        <radialGradient id="cc-grape" cx="38%" cy="32%" r="70%">
          <stop offset="0" stopColor="#d2b8ff" />
          <stop offset="0.6" stopColor="#6a3fd6" />
          <stop offset="1" stopColor="#35188f" />
        </radialGradient>
        <radialGradient id="cc-peach" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#ffe0ef" />
          <stop offset="0.6" stopColor="#ff7fb8" />
          <stop offset="1" stopColor="#d43d83" />
        </radialGradient>
        <radialGradient id="cc-bomb" cx="40%" cy="35%" r="70%">
          <stop offset="0" stopColor="#fff3b0" />
          <stop offset="0.5" stopColor="#ffb21f" />
          <stop offset="1" stopColor="#e2401f" />
        </radialGradient>
        <filter id="cc-shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="3" stdDeviation="2.5" floodColor="#3a0a3a" floodOpacity="0.45" />
        </filter>

        <symbol id="candy-HEART" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <path d="M50 88 C18 64 8 46 14 30 C20 14 42 12 50 30 C58 12 80 14 86 30 C92 46 82 64 50 88Z" fill="url(#cc-heart)" stroke="#7a0016" strokeWidth="2.5" />
            {GLOSS}
          </g>
        </symbol>
        <symbol id="candy-STAR" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <path d="M50 8 L61 36 L91 38 L68 57 L76 87 L50 70 L24 87 L32 57 L9 38 L39 36Z" fill="url(#cc-star)" stroke="#3f0b7a" strokeWidth="2.5" strokeLinejoin="round" />
            {GLOSS}
          </g>
        </symbol>
        <symbol id="candy-MOON" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <path d="M64 10 C36 12 16 32 16 56 C16 76 34 92 56 90 C70 89 82 82 88 70 C80 74 70 76 62 74 C44 70 34 54 38 36 C41 24 50 14 64 10Z" fill="url(#cc-moon)" stroke="#0b5c1d" strokeWidth="2.5" />
            <ellipse cx="34" cy="44" rx="7" ry="13" fill="#fff" opacity="0.45" transform="rotate(20 34 44)" />
          </g>
        </symbol>
        <symbol id="candy-GEM" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <path d="M24 16 H76 L92 40 L50 90 L8 40Z" fill="url(#cc-gem)" stroke="#073a7d" strokeWidth="2.5" strokeLinejoin="round" />
            <path d="M8 40 H92 M24 16 L38 40 L50 90 L62 40 L76 16 M38 40 L50 16 L62 40" fill="none" stroke="#e9f7ff" strokeWidth="1.6" opacity="0.7" />
          </g>
        </symbol>
        <symbol id="candy-ORANGE" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <path d="M14 78 C12 46 28 18 50 18 C72 18 88 46 86 78 C70 86 30 86 14 78Z" fill="url(#cc-orange)" stroke="#8a3600" strokeWidth="2.5" />
            {[24, 34, 44, 56, 66, 76, 30, 50, 70, 40, 60].map((x, i) => (
              <circle key={i} cx={x} cy={i < 6 ? 62 : i < 9 ? 44 : 32} r="2.2" fill="#fff2d6" opacity="0.8" />
            ))}
            <ellipse cx="38" cy="34" rx="10" ry="6" fill="#fff" opacity="0.4" transform="rotate(-25 38 34)" />
          </g>
        </symbol>
        <symbol id="candy-LEMON" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <rect x="16" y="16" width="68" height="68" rx="16" fill="url(#cc-lemon)" stroke="#8f6a00" strokeWidth="2.5" />
            <rect x="28" y="28" width="44" height="44" rx="10" fill="none" stroke="#fffbd6" strokeWidth="3" opacity="0.7" />
            {GLOSS}
          </g>
        </symbol>
        <symbol id="candy-MINT" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <circle cx="50" cy="50" r="36" fill="url(#cc-mint)" stroke="#1f8f7a" strokeWidth="2.5" />
            {[0, 60, 120, 180, 240, 300].map((deg) => (
              <path key={deg} d="M50 50 L50 14 A36 36 0 0 1 81 32Z" fill="#14b89a" opacity="0.85" transform={`rotate(${deg} 50 50)`} />
            ))}
            <circle cx="50" cy="50" r="8" fill="#fff" />
            {GLOSS}
          </g>
        </symbol>
        <symbol id="candy-GRAPE" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <circle cx="50" cy="52" r="34" fill="url(#cc-grape)" stroke="#250a6b" strokeWidth="2.5" />
            <circle cx="40" cy="40" r="9" fill="#fff" opacity="0.5" />
            <circle cx="62" cy="68" r="4" fill="#fff" opacity="0.25" />
          </g>
        </symbol>
        <symbol id="candy-PEACH" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <path d="M8 34 L28 42 L28 58 L8 66Z M92 34 L72 42 L72 58 L92 66Z" fill="#ffc2dd" stroke="#b02c6a" strokeWidth="2.5" strokeLinejoin="round" />
            <ellipse cx="50" cy="50" rx="25" ry="20" fill="url(#cc-peach)" stroke="#b02c6a" strokeWidth="2.5" />
            <ellipse cx="42" cy="42" rx="8" ry="4.5" fill="#fff" opacity="0.5" transform="rotate(-20 42 42)" />
          </g>
        </symbol>
        <symbol id="candy-LOLLIPOP" viewBox="0 0 100 100">
          <g filter="url(#cc-shadow)">
            <rect x="46" y="58" width="8" height="38" rx="4" fill="#fff" stroke="#c9b6d6" strokeWidth="1.5" />
            <circle cx="50" cy="40" r="34" fill="#fff" stroke="#c2185b" strokeWidth="2.5" />
            {["#ff3d7f", "#ffb01f", "#2fcf4d", "#2b9cf2", "#9b3ff0"].map((colour, i) => (
              <path key={colour} d={`M50 40 m0 ${-30 + i * 2} a${30 - i * 5} ${30 - i * 5} 0 1 1 -0.1 0`} fill="none" stroke={colour} strokeWidth="5.5" strokeLinecap="round" strokeDasharray={`${55 - i * 7} 400`} transform={`rotate(${i * 72} 50 40)`} />
            ))}
            <circle cx="50" cy="40" r="5" fill="#ff3d7f" />
            <ellipse cx="36" cy="24" rx="10" ry="5" fill="#fff" opacity="0.6" transform="rotate(-25 36 24)" />
          </g>
        </symbol>
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

/** One candy, as drawn above. A multiplier candy shows its value. */
export function CandyIcon({ cell, className }: { cell: CandyCell; className?: string }) {
  const multiplier = cell.startsWith("X") ? cell.slice(1) : null;
  return (
    <svg className={`candy-icon${multiplier ? " is-multiplier" : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 100 100" aria-hidden="true">
      <use href={`#candy-${multiplier ? "X" : cell}`} />
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
  ORANGE: "Gumdrop",
  LEMON: "Lemon jelly",
  MINT: "Mint",
  GRAPE: "Gumball",
  PEACH: "Bonbon",
  LOLLIPOP: "Lollipop",
};
