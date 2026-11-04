/**
 * Shtatat.al's Crash. A multiplier climbs from 1.00× and crashes at a point
 * nobody can see; the Player cashes out before it does and is paid the stake
 * times the multiplier at that moment, or loses the stake if it crashes first.
 * They can also set an automatic cash-out, which the server applies.
 *
 * The crash point is drawn when the round starts: from a uniform u in (0, 1],
 * it's 0.75/u floored to the cent, so it reaches x with probability 0.75/x
 * (so about 26% of rounds, all those that would land below 1.01×, crash at 1.00× at once). Cashing out at any x pays back 75%
 * on average. It's capped at 5,000×.
 *
 * The multiplier at t milliseconds after the start is e^(0.00006·t), floored
 * to the cent: 2× after about 11.6 s, 10× after 38 s. The server's clock
 * decides: a cash-out is paid at the multiplier when it arrives, if that's
 * still below the crash point. This file is the game's whole definition.
 */

export const GAME_NAME = "Crash";
export const BETS = [50, 100, 250, 500, 1000, 2500] as const;
export const PAYOUT_RATE = 75;
export const MAX_MULTIPLIER = 5000;
/** How fast it climbs: the multiplier is e^(GROWTH · ms). */
export const GROWTH = 0.00006;
/** The lowest automatic cash-out. */
export const MIN_AUTO = 1.01;

export type Phase = "PLAY" | "WON" | "LOST";
export type Round = {
  bet: number;
  /** The crash point, in hundredths. Never sent while the round is on. */
  crash: number;
  /** When the climb started, ms since the epoch (the server's clock). */
  startedAt: number;
  /** The automatic cash-out, in hundredths, or null. */
  auto: number | null;
  phase: Phase;
  /** Where it was cashed out, in hundredths (WON), or where it crashed (LOST). */
  at: number | null;
  payout: number;
};

export class CrashError extends Error {}

/** The crash point in hundredths, from a uniform fraction u in (0, 1]. */
export function crashPointFor(u: number): number {
  if (!(u > 0) || u > 1) throw new Error("u must be in (0, 1]");
  return Math.max(100, Math.min(MAX_MULTIPLIER * 100, Math.floor((PAYOUT_RATE / u) )));
}

/** A uniform u in (0, 1] from `draw`: 2^32 equally likely values. */
export function drawU(draw: (below: number) => number): number {
  const high = draw(65536);
  const low = draw(65536);
  return (high * 65536 + low + 1) / 4294967296;
}

/** The multiplier in hundredths, `ms` after the start. */
export const multiplierAt = (ms: number) => Math.floor(Math.exp(GROWTH * Math.max(0, ms)) * 100);
/** How long after the start the multiplier reaches `hundredths`. */
export const msToReach = (hundredths: number) => Math.log(hundredths / 100) / GROWTH;

export function startRound(betCents: number, auto: number | null, draw: (below: number) => number, now: number): Round {
  return { bet: betCents, crash: crashPointFor(drawU(draw)), startedAt: now, auto, phase: "PLAY", at: null, payout: 0 };
}

/**
 * Where the round stands at `now`: still climbing, cashed out by the automatic
 * cash-out (when it's below the crash point and has been reached), or crashed.
 */
export function advance(round: Round, now: number): Round {
  if (round.phase !== "PLAY") return round;
  const current = multiplierAt(now - round.startedAt);
  if (round.auto !== null && round.auto < round.crash && current >= round.auto) {
    return { ...round, phase: "WON", at: round.auto, payout: Math.floor((round.bet * round.auto) / 100) };
  }
  if (current >= round.crash) return { ...round, phase: "LOST", at: round.crash, payout: 0 };
  return round;
}

/** Cashes out at the multiplier at `now`, unless it has already crashed (or cashed out by itself). */
export function cashOut(round: Round, now: number): Round {
  const settled = advance(round, now);
  if (settled.phase !== "PLAY") return settled;
  const at = Math.max(100, multiplierAt(now - round.startedAt));
  return { ...round, phase: "WON", at, payout: Math.floor((round.bet * at) / 100) };
}

/** The round as the Player sees it: the crash point only once it's over. */
export function publicView(round: Round, now: number) {
  return {
    bet: round.bet / 100,
    phase: round.phase,
    startedAt: new Date(round.startedAt).toISOString(),
    /** The server's clock now, so the page can line its animation up with it. */
    serverNow: new Date(now).toISOString(),
    auto: round.auto === null ? null : round.auto / 100,
    multiplier: round.phase === "PLAY" ? multiplierAt(now - round.startedAt) / 100 : (round.at ?? 0) / 100,
    crash: round.phase === "PLAY" ? null : round.crash / 100,
    at: round.at === null ? null : round.at / 100,
    payout: round.payout / 100,
  };
}
