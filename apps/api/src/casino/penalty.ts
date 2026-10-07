/**
 * Bast.al's Penalty. The Player takes kicks, aiming left, center or right.
 * The keeper dives one of those three ways. A different way is a goal and
 * raises the multiplier; the same way is a save and loses the stake. They
 * can cash out after any goal. This file is the game's whole definition,
 * used as it is by the API and the tests, so what's tested is what's played.
 *
 * The first two goals each multiply by the fair 1.5 (each kick scores 2
 * times in 3), times 92%: cashing out after 1 or 2 goals pays back 92% on
 * average. Every goal after that multiplies by 1.45 instead, so the house
 * keeps a little more the longer a round runs (89% back after 3 goals, 83%
 * after 5, 70% after 10). Floored to the cent. A round pays at most 5,000
 * times the bet, the same ceiling as Book of Ra, and stops there.
 */

export const GAME_NAME = "Penalty";

/** Where a kick can go, and where the keeper can dive. */
export const DIRECTIONS = ["LEFT", "CENTER", "RIGHT"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** What a round can cost, in dollars. The same chips as the fruit slot. */
export const BETS = [0.5, 1, 2, 5, 10] as const;
/** The house's edge on every cash-out: 8%, so a round pays back 92% on average. */
export const HOUSE_EDGE = 0.08;
/** What a round cashed out after 1 or 2 goals pays back on average, in percent of the stake, before cents are floored. */
export const PAYOUT_RATE = 92;
/** Goals that multiply by the fair 1.5. */
export const FULL_PRICE_GOALS = 2;
/** What each goal after those multiplies by, below the fair 1.5. */
export const LATER_STEP = 1.45;
/** The most a round pays, in times the bet. */
export const MAX_WIN = 5000;

export type Phase = "PLAY" | "WON" | "LOST";

/** One kick: where it was aimed, and where the keeper went. */
export type Shot = { aim: Direction; dive: Direction };

/** A shootout still being played, or just finished. Amounts are cents. */
export type Round = {
  bet: number;
  /** Goals, in the order they were scored. */
  goals: Shot[];
  /** The kick the keeper saved, once the round is lost. */
  save: Shot | null;
  phase: Phase;
  /** Cents paid back, once the round is over. 0 when it's lost. */
  payout: number;
  capped: boolean;
};

/** A kick as the Player sees it, after it has been taken. */
export type KickView = Shot & { goal: boolean };

/** A shootout as the Player may see it. The next dive isn't chosen until they kick. */
export type RoundView = {
  phase: Phase;
  bet: number;
  goals: number;
  /** The cash-out multiplier now: 1 before any goal, and the paid one once the round is over. */
  multiplier: number;
  /** The multiplier after one more goal. Null once the round is over. */
  nextMultiplier: number | null;
  /** Dollars paid back if they cash out now, or what the finished round paid. */
  cashout: number;
  capped: boolean;
  kicks: KickView[];
};

export class PenaltyError extends Error {}

const money = (cents: number) => Math.round(cents) / 100;

/** The multiplier after `goals` goals, in hundredths (145 is 1.45), floored, and never past MAX_WIN. */
export function multiplierHundredths(goals: number): number {
  if (goals <= 0) return 100;
  // PAYOUT_RATE% of (3/2) per goal, each kick scoring unless the keeper matches 1 of 3
  // directions, and of LATER_STEP (29/20) per goal past FULL_PRICE_GOALS.
  let num = BigInt(PAYOUT_RATE);
  let den = 1n;
  for (let step = 0; step < goals; step++) {
    num *= step < FULL_PRICE_GOALS ? 3n : BigInt(Math.round(LATER_STEP * 20));
    den *= step < FULL_PRICE_GOALS ? 2n : 20n;
  }
  const hundredths = num / den;
  const cap = BigInt(MAX_WIN) * 100n;
  return Number(hundredths > cap ? cap : hundredths);
}

/** What cashing out after `goals` goals pays, in cents, floored, and never past MAX_WIN times the stake. */
export function payoutCents(stakeCents: number, goals: number): number {
  if (goals <= 0) return 0;
  const raw = Math.floor((stakeCents * multiplierHundredths(goals)) / 100);
  return Math.min(raw, stakeCents * MAX_WIN);
}

function direction(index: number): Direction {
  const aim = DIRECTIONS[index];
  if (!aim) throw new PenaltyError("Aim left, center or right.");
  return aim;
}

/** Starts a shootout: the bet (cents) down, no kicks taken. */
export function startRound(betCents: number): Round {
  return { bet: betCents, goals: [], save: null, phase: "PLAY", payout: 0, capped: false };
}

function finish(round: Round, phase: "WON" | "LOST", save: Shot | null): Round {
  const capped = phase === "WON" && multiplierHundredths(round.goals.length) >= MAX_WIN * 100;
  return { ...round, phase, save, payout: phase === "WON" ? payoutCents(round.bet, round.goals.length) : 0, capped };
}

/**
 * One kick. `draw(n)` returns an integer from 0 up to, but not including, n:
 * that's where the keeper dives. The same way as the aim is a save.
 */
export function kick(round: Round, aim: Direction, draw: (below: number) => number): Round {
  if (round.phase !== "PLAY") throw new PenaltyError("This round is already over.");
  if (!(DIRECTIONS as readonly string[]).includes(aim)) throw new PenaltyError("Aim left, center or right.");
  const shot: Shot = { aim, dive: direction(draw(DIRECTIONS.length)) };
  if (shot.dive === shot.aim) return finish(round, "LOST", shot);
  const next: Round = { ...round, goals: [...round.goals, shot] };
  if (multiplierHundredths(next.goals.length) >= MAX_WIN * 100) return finish(next, "WON", null);
  return next;
}

/** Takes the win so far. The first kick has to be a goal. */
export function cashOut(round: Round): Round {
  if (round.phase !== "PLAY") throw new PenaltyError("This round is already over.");
  if (round.goals.length === 0) throw new PenaltyError("Score a goal before you cash out.");
  return finish(round, "WON", null);
}

/** The shootout for the client. Kicks already taken show where the keeper went. */
export function publicView(round: Round): RoundView {
  const hundredths = multiplierHundredths(round.goals.length);
  const next = round.phase === "PLAY" ? multiplierHundredths(round.goals.length + 1) : null;
  const kicks: KickView[] = [
    ...round.goals.map((shot) => ({ ...shot, goal: true })),
    ...(round.save ? [{ ...round.save, goal: false }] : []),
  ];
  return {
    phase: round.phase,
    bet: money(round.bet),
    goals: round.goals.length,
    multiplier: hundredths / 100,
    nextMultiplier: next === null ? null : next / 100,
    cashout: money(round.phase === "PLAY" ? payoutCents(round.bet, round.goals.length) : round.payout),
    capped: round.capped,
    kicks,
  };
}
