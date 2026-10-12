import { useId, type ReactNode } from "react";
import type { Sport } from "../lib/api";

/** Line icons for the sports that aren't a ball. The balls are drawn in their real colors. */
export function SportIcon({ sport }: { sport: Sport }) {
  const clip = `ball${useId().replace(/:/g, "")}`;
  if (sport === "football") return <Football clip={clip} />;
  if (sport === "basketball") return <Basketball clip={clip} />;
  if (sport === "tennis") return <Tennis clip={clip} />;
  if (sport === "volleyball") return <Volleyball clip={clip} />;
  if (sport === "handball") return <Handball clip={clip} />;
  if (sport === "nfl") return <NflBall />;
  if (sport === "greyhounds")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.4 13.4c2.4-1.5 5-1.6 7.2-.4 1.2.6 2.1.1 3.2-.8 1.5-1.2 3.1-2.5 5-2.8 1.1-.2 2.1.3 2.6 1.2" />
        <path d="M20.2 10.5c.7.3 1.3.9 1.6 1.6" />
        <path d="M18.2 8.8c-.3-1.2-1.1-1.7-1.8-1.1" />
        <path d="M16.8 11.4c.7 1.1.3 2.3-.8 2.9" />
        <path d="M15.6 14.2c-2.5.5-4.8.1-6.6.5-1.5.3-2.6-.3-3.4-1.3" />
        <path d="M7.6 14.6 5.8 18.6M10.2 14.8 9.2 18.8M14.4 14.2 16.6 18.4M16.6 12.8 19.4 16.6" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="13.2" cy="8.8" r="4.5" />
      <path d="M8.9 10.2H6.6a1.6 1.6 0 0 0 0 3.2h2.1" />
      <path d="M10.6 13v4.2h5.2V13.6" />
    </svg>
  );
}

function Ball({ clip, base, shade, children }: { clip: string; base: string; shade: string; children?: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="sport-ball" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <circle cx="12" cy="12" r="10" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <circle cx="12" cy="12" r="10" fill={base} />
        <circle cx="14.4" cy="15.4" r="8.6" fill={shade} />
        <circle cx="8.4" cy="7.8" r="4.4" fill="#fff" opacity="0.38" />
        {children}
      </g>
      <circle cx="12" cy="12" r="9.7" fill="none" stroke="rgb(0 0 0 / 40%)" strokeWidth="1" />
    </svg>
  );
}

function points(cx: number, cy: number, r: number, turn: number) {
  return Array.from({ length: 5 }, (_, i) => {
    const a = ((turn + i * 72) * Math.PI) / 180;
    return `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
  }).join(" ");
}

function Football({ clip }: { clip: string }) {
  return (
    <Ball clip={clip} base="#f4f5f7" shade="#c8ccd3">
      <polygon points={points(12, 12.15, 3.15, -90)} fill="#1a1a1a" />
      {[-90, -18, 54, 126, 198].map((turn) => {
        const a = (turn * Math.PI) / 180;
        return <circle key={turn} cx={12 + Math.cos(a) * 10.5} cy={12.15 + Math.sin(a) * 10.5} r="3.35" fill="#1a1a1a" />;
      })}
    </Ball>
  );
}

function Basketball({ clip }: { clip: string }) {
  return (
    <Ball clip={clip} base="#f97316" shade="#c2410c">
      <path d="M12 2v20M2 12h20" stroke="#1c1917" strokeWidth="1.15" />
      <path d="M4.8 4.9c2.1 1.9 3.3 4.3 3.3 7.1s-1.2 5.2-3.3 7.1M19.2 4.9c-2.1 1.9-3.3 4.3-3.3 7.1s1.2 5.2 3.3 7.1" stroke="#1c1917" strokeWidth="1.15" fill="none" />
    </Ball>
  );
}

function Tennis({ clip }: { clip: string }) {
  return (
    <Ball clip={clip} base="#d6ef4a" shade="#a8c72e">
      <path d="M6.4 4.6c2.8 2.6 2.8 12.2 0 14.8M17.6 4.6c-2.8 2.6-2.8 12.2 0 14.8" stroke="#f8faf5" strokeWidth="1.35" fill="none" />
    </Ball>
  );
}

function Volleyball({ clip }: { clip: string }) {
  return (
    <Ball clip={clip} base="#f8fafc" shade="#d5dde8">
      <path d="M12 2c5.2 3.2 7.4 7.2 6.2 12.2-2.6-1.6-5.4-1.6-8.2.2C7.2 8.6 8.2 4.2 12 2z" fill="#1d4ed8" />
      <path d="M3.2 15.4c3.2-1.6 6.4-1.2 9.4 1.2 1.2 3.6.2 6.4-2.6 7.6-3.6-.2-6.2-2.2-7.2-5.2-.4-1.2-.2-2.4.4-3.6z" fill="#f5c518" />
    </Ball>
  );
}

function Handball({ clip }: { clip: string }) {
  return (
    <Ball clip={clip} base="#e11d2e" shade="#9f1239">
      <path d="M7.2 5.4c2.2 2.1 3.3 4.2 3.3 6.6s-1.1 4.5-3.3 6.6M16.8 5.4c-2.2 2.1-3.3 4.2-3.3 6.6s1.1 4.5 3.3 6.6M3.6 12h16.8" stroke="#fff" strokeWidth="0.7" fill="none" opacity="0.9" />
    </Ball>
  );
}

function NflBall() {
  return (
    <svg viewBox="0 0 24 24" className="sport-ball" aria-hidden="true">
      <g transform="rotate(-36 12 12)">
        <ellipse cx="12" cy="12" rx="10.3" ry="6" fill="#8b5a32" />
        <ellipse cx="13.4" cy="13.2" rx="7.4" ry="3.5" fill="#6b4122" />
        <ellipse cx="9.2" cy="10.2" rx="3.4" ry="1.7" fill="#e2b48c" opacity="0.55" />
        <path d="M6.4 10.5c.25 1.5.25 3 0 4.5M17.6 10.5c-.25 1.5-.25 3 0 4.5" stroke="#f6f1ea" strokeWidth="1.2" fill="none" />
        <path d="M12 8.6v6.8" stroke="#f6f1ea" strokeWidth="0.6" fill="none" />
        <path d="M10.5 10h3M10.5 12h3M10.5 14h3" stroke="#f6f1ea" strokeWidth="0.9" fill="none" />
      </g>
    </svg>
  );
}
