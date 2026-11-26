/**
 * Candy Cascade's candies: every candy is WebP artwork; a multiplier candy is the rainbow bomb with its value on it.
 */
import type { CandyCell } from "../lib/api";

const ART: Record<string, string> = {
  HEART: "/casino/candy/heart.webp",
  STAR: "/casino/candy/star.webp",
  MOON: "/casino/candy/moon.webp?v=2",
  GEM: "/casino/candy/gem.webp?v=2",
  ORANGE: "/casino/candy/orange.webp",
  LEMON: "/casino/candy/lemon.webp?v=2",
  MINT: "/casino/candy/mint.webp?v=2",
  GRAPE: "/casino/candy/grape.webp",
  PEACH: "/casino/candy/peach.webp?v=2",
  LOLLIPOP: "/casino/candy/lollipop.webp?v=2",
};

/** The multiplier candy: a rainbow candy bomb. */
const BOMB = "/casino/candy/bomb.webp";

/** One candy. A multiplier candy shows its value on the bomb art. */
export function CandyIcon({ cell, className }: { cell: CandyCell; className?: string }) {
  const multiplier = cell.startsWith("X") ? cell.slice(1) : null;
  const art = multiplier ? null : ART[cell];
  return (
    <svg className={`candy-icon${multiplier ? " is-multiplier" : ""}${className ? ` ${className}` : ""}`} viewBox="0 0 100 100" aria-hidden="true">
      <image href={art ?? BOMB} x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />
      {multiplier ? (
        <text x="46" y="62" textAnchor="middle" dominantBaseline="middle" className="candy-multiplier-text" fontSize={multiplier.length > 2 ? 27 : 34}>
          {multiplier}X
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
