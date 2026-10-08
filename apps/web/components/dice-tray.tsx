"use client";

import type { CSSProperties } from "react";

/**
 * Dice's tray without WebGL: four dice, one for each digit of the roll, so
 * 42.73 lands as 4, 2, 7 and 3. Four digits from 0 to 9, each as likely, are
 * the game's 10,000 rolls, so what the dice show is the roll itself, not a
 * picture of it. The 3D tray (dice-3d.tsx) throws real ten-sided dice; this
 * one draws them as numbered cubes in CSS 3D, read from the top, with 6 and 9
 * underlined. They land one after another, left to right.
 */

/** One throw of the dice: the digits they land on, and how each tumbles in. */
export type DiceThrow = {
  digits: number[];
  /** A new key starts the animation again. */
  key: number;
  /** How long the first die tumbles, and how much later each next one lands, in ms. 0 lands them at once. */
  duration: number;
  stagger: number;
  /** Each die's starting turn, in degrees: [x, y, z]. */
  spins: Array<[number, number, number]>;
};

/** A throw's starting turns: two to three full turns on each axis, a different mix for each die. */
export function newThrow(roll: number, key: number, duration: number, stagger: number): DiceThrow {
  const digits = String(roll).padStart(4, "0").split("").map(Number);
  const turn = () => (Math.random() < 0.5 ? -1 : 1) * (720 + Math.round(Math.random() * 360));
  return { digits, key, duration, stagger, spins: digits.map(() => [turn(), turn(), Math.round((Math.random() - 0.5) * 180)]) };
}

/** When the last die of a throw lands, in ms after it starts. */
export const throwLength = (dice: Pick<DiceThrow, "duration" | "stagger" | "digits">) => (dice.duration > 0 ? dice.duration + dice.stagger * (dice.digits.length - 1) : 0);

const FACES = ["top", "front", "right", "back", "left", "bottom"] as const;

/** The digits on a die's faces: its own on top, and others (never its own) on the rest. */
function faceDigits(digit: number, seed: number): number[] {
  return FACES.map((_, face) => {
    if (face === 0) return digit;
    const other = 1 + ((seed * 7 + face * 3) % 9);
    return other === digit ? (other % 9) + 1 : other;
  });
}

function Numeral({ digit }: { digit: number }) {
  return <span className={`dice-number${digit === 6 || digit === 9 ? " is-marked" : ""}`}>{digit}</span>;
}

export function DiceTray({ dice, rolling, outcome, label }: { dice: DiceThrow | null; rolling: boolean; outcome: "win" | "loss" | null; label: string }) {
  const digits = dice?.digits ?? [0, 0, 0, 0];
  const still = !dice || dice.duration <= 0;
  return (
    <div className={`dice-tray${rolling ? " is-rolling" : ""}${outcome ? ` is-${outcome}` : ""}${dice ? "" : " is-idle"}`} role="img" aria-label={label}>
      {digits.map((digit, index) => (
        <span key={index} className="dice-slot">
          {index === 2 ? <span className="dice-point" aria-hidden="true" /> : null}
          <span
            key={dice?.key ?? 0}
            className={`dice-scene${still ? " is-still" : ""}`}
            style={
              {
                "--dur": `${(dice?.duration ?? 0) + (dice?.stagger ?? 0) * index}ms`,
                "--rx": `${dice?.spins[index][0] ?? 0}deg`,
                "--ry": `${dice?.spins[index][1] ?? 0}deg`,
                "--rz": `${dice?.spins[index][2] ?? 0}deg`,
              } as CSSProperties
            }
          >
            <span className="dice-shadow" aria-hidden="true" />
            <span className="dice-cube" aria-hidden="true">
              {FACES.map((face) => (
                <span key={face} className={`dice-solid is-${face}`} />
              ))}
              {faceDigits(digit, (dice?.key ?? 0) + index).map((value, face) => (
                <span key={FACES[face]} className={`dice-face is-${FACES[face]}`}>
                  <Numeral digit={value} />
                </span>
              ))}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}
