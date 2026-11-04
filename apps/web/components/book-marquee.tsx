"use client";

/**
 * The top of Book of Ra's cabinet, after the original: a stormy desert
 * sunset with palms and pyramids, drawn here in SVG, and the game's logo (a
 * picture, public/casino/book-of-ra/logo.webp) over it. The sky fills the bar;
 * the logo keeps its shape in the middle.
 */

import { memo } from "react";

function Marquee() {
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

      {/* eslint-disable-next-line @next/next/no-img-element -- a small static picture, already sized for the bar */}
      <img className="book-marquee-logo" src="/casino/book-of-ra/logo.webp" alt="" draggable={false} />
    </>
  );
}

/** Drawn once: nothing in it changes while the game plays. */
export const BookMarquee = memo(Marquee);
