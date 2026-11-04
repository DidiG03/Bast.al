/**
 * Shtatat.al's Tower. A tower of 8 floors, each a row of doors with traps
 * behind some. The Player opens one door on each floor, from the bottom up;
 * a safe door takes them a floor higher and raises the multiplier, a trap
 * loses the stake. They can cash out after any floor, and the top floor
 * cashes out by itself.
 *
 * The difficulty sets each floor: Easy is 4 doors with 1 trap, Medium 3 with
 * 1, Hard 2 with 1, Expert 3 with 2. The multiplier after k floors is 85% of
 * the fair price of surviving them, floored to the cent, so cashing out pays
 * back 85% on average at any floor. A climb pays at most 5,000 times the
 * stake. The traps are placed when the climb starts and shown when it ends.
 * This file is the game's whole definition, used by the API and the tests.
 */

export const GAME_NAME = "Tower";
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
export const PAYOUT_RATE = 85;
export const MAX_WIN = 5000;
export const FLOORS = 8;

export const LEVELS = ["EASY", "MEDIUM", "HARD", "EXPERT"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_SHAPE: Record<Level, { doors: number; traps: number }> = {
  EASY: { doors: 4, traps: 1 },
  MEDIUM: { doors: 3, traps: 1 },
  HARD: { doors: 2, traps: 1 },
  EXPERT: { doors: 3, traps: 2 },
};

export type Phase = "PLAY" | "WON" | "LOST";
export type Round = {
  bet: number;
  level: Level;
  phase: Phase;
  /** The trapped doors on each floor, bottom first. Never sent while the climb is on. */
  traps: number[][];
  /** The door opened on each floor climbed so far (and the trap, on a loss). */
  picks: number[];
  payout: number;
};

export class TowerError extends Error {}

/** The multiplier after `floors` safe floors, in hundredths: 85% of the fair price, floored, at most MAX_WIN. */
export function multiplierHundredths(level: Level, floors: number): number {
  if (floors === 0) return 0;
  const { doors, traps } = LEVEL_SHAPE[level];
  const safe = doors - traps;
  // 85 × (doors/safe)^floors, in exact whole numbers.
  const value = (BigInt(PAYOUT_RATE) * BigInt(doors) ** BigInt(floors)) / BigInt(safe) ** BigInt(floors);
  return value >= BigInt(MAX_WIN * 100) ? MAX_WIN * 100 : Number(value);
}

export function startRound(betCents: number, level: Level, draw: (below: number) => number): Round {
  const { doors, traps } = LEVEL_SHAPE[level];
  const floors: number[][] = [];
  for (let floor = 0; floor < FLOORS; floor++) {
    const left = Array.from({ length: doors }, (_, door) => door);
    const trapped: number[] = [];
    for (let n = 0; n < traps; n++) trapped.push(left.splice(draw(left.length), 1)[0]);
    floors.push(trapped.sort((a, b) => a - b));
  }
  return { bet: betCents, level, phase: "PLAY", traps: floors, picks: [], payout: 0 };
}

/** Opens a door on the next floor. */
export function climb(round: Round, door: number): Round {
  if (round.phase !== "PLAY") throw new TowerError("This climb is over. Start a new one.");
  const { doors } = LEVEL_SHAPE[round.level];
  if (!Number.isInteger(door) || door < 0 || door >= doors) throw new TowerError("Pick one of the doors on this floor.");
  const floor = round.picks.length;
  const picks = [...round.picks, door];
  if (round.traps[floor].includes(door)) return { ...round, picks, phase: "LOST", payout: 0 };
  const next = { ...round, picks };
  if (picks.length === FLOORS || multiplierHundredths(round.level, picks.length) >= MAX_WIN * 100) return cashOut(next);
  return next;
}

export function cashOut(round: Round): Round {
  if (round.phase !== "PLAY") throw new TowerError("This climb is over. Start a new one.");
  if (round.picks.length === 0) throw new TowerError("Climb at least one floor before you cash out.");
  return { ...round, phase: "WON", payout: Math.floor((round.bet * multiplierHundredths(round.level, round.picks.length)) / 100) };
}

/** The climb as the Player sees it: the traps only once it's over. */
export function publicView(round: Round) {
  const floors = round.picks.length;
  return {
    bet: round.bet / 100,
    level: round.level,
    phase: round.phase,
    picks: round.picks,
    traps: round.phase === "PLAY" ? null : round.traps,
    floors,
    multiplier: multiplierHundredths(round.level, floors) / 100,
    nextMultiplier: floors < FLOORS ? multiplierHundredths(round.level, floors + 1) / 100 : null,
    cashOutNow: Math.floor((round.bet * multiplierHundredths(round.level, floors)) / 100) / 100,
    payout: round.payout / 100,
  };
}

/** Each floor's multiplier for a difficulty, for the board and the rules. */
export const ladder = (level: Level) => Array.from({ length: FLOORS }, (_, i) => multiplierHundredths(level, i + 1) / 100);
