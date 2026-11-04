import { BadRequestException, Injectable } from "@nestjs/common";
import { Actor } from "../auth/permissions";
import * as Baccarat from "./baccarat";
import * as Crash from "./crash";
import * as Hilo from "./hilo";
import { HouseService } from "./house.service";
import * as Tower from "./tower";
import * as Wheel from "./wheel";

/**
 * Money Wheel, Baccarat, Hi-Lo, Tower and Crash: each game's rules (in its
 * own file) on the shared money side (HouseService). Every request returns the
 * new balance, so the page never has to guess it.
 */
@Injectable()
export class HouseGamesService {
  constructor(private readonly house: HouseService) {
    // A round nobody finished: Hi-Lo and Tower cash out what they've won (or give the stake back if
    // nothing was played); Crash plays itself out (an automatic cash-out, or the crash).
    house.onIdle<Hilo.Round>("hilo", (state) => (state.steps.some((step) => step.correct === true) ? { state: Hilo.cashOut(state), payoutCents: Hilo.cashOut(state).payout } : "refund"));
    house.onIdle<Tower.Round>("tower", (state) => (state.picks.length > 0 ? { state: Tower.cashOut(state), payoutCents: Tower.cashOut(state).payout } : "refund"));
    house.onIdle<Crash.Round>("crash", (state, now) => {
      const settled = Crash.advance(state, now);
      return { state: settled, payoutCents: settled.payout };
    });
  }

  // ——— Money Wheel ———

  async wheelState(actor: Actor) {
    return { ...(await this.house.basics(actor, "wheel", Wheel.BETS)), game: { name: Wheel.GAME_NAME, bets: Wheel.BETS, risks: Wheel.RISKS, wheels: Object.fromEntries(Wheel.RISKS.map((risk) => [risk, Wheel.WHEELS[risk].map((value) => value / 100)])), payoutRate: Wheel.PAYOUT_RATE } };
  }

  async wheelSpin(actor: Actor, bet: number, risk: string) {
    if (!(Wheel.RISKS as readonly string[]).includes(risk)) throw new BadRequestException("Pick low, medium or high risk.");
    let spun: { segment: number; multiplier: number } = { segment: 0, multiplier: 0 };
    const result = await this.house.instant(actor, "wheel", bet, Wheel.BETS, (stakeCents, draw) => {
      spun = Wheel.spin(risk as Wheel.Risk, draw);
      return { payoutCents: Wheel.winCents(stakeCents, spun.multiplier), record: { risk, segment: spun.segment, multiplier: spun.multiplier / 100 } };
    });
    return { id: result.id, balance: result.balance, risk, segment: spun.segment, multiplier: spun.multiplier / 100, bet, win: Wheel.winCents(Math.round(bet * 100), spun.multiplier) / 100 };
  }

  // ——— Baccarat ———

  async baccaratState(actor: Actor) {
    return { ...(await this.house.basics(actor, "baccarat", Baccarat.BETS)), game: { name: Baccarat.GAME_NAME, bets: Baccarat.BETS, sides: Baccarat.SIDES, payoutRates: Baccarat.PAYOUT_RATES } };
  }

  async baccaratDeal(actor: Actor, bet: number, side: string) {
    if (!(Baccarat.SIDES as readonly string[]).includes(side)) throw new BadRequestException("Bet on Player, Banker or Tie.");
    let hand: Baccarat.Hand | null = null;
    let payout = 0;
    const result = await this.house.instant(actor, "baccarat", bet, Baccarat.BETS, (stakeCents, draw) => {
      hand = Baccarat.deal(draw);
      payout = Baccarat.payoutCents(stakeCents, side as Baccarat.Side, hand.winner);
      return { payoutCents: payout, record: { side, ...hand } };
    });
    return { id: result.id, balance: result.balance, side, hand: hand!, bet, win: payout / 100 };
  }

  // ——— Hi-Lo ———

  async hiloState(actor: Actor) {
    const [basics, open] = await Promise.all([this.house.basics(actor, "hilo", Hilo.BETS), this.house.openRound(actor.id, "hilo")]);
    return { ...basics, round: open ? Hilo.publicView(open.state as unknown as Hilo.Round) : null, game: { name: Hilo.GAME_NAME, bets: Hilo.BETS, payoutRate: Hilo.PAYOUT_RATE, maxWin: Hilo.MAX_WIN } };
  }

  async hiloStart(actor: Actor, bet: number) {
    const result = await this.house.start(actor, "hilo", bet, Hilo.BETS, (cents, draw) => Hilo.startRound(cents, draw));
    return { round: Hilo.publicView(result.state), balance: result.balance };
  }

  async hiloGuess(actor: Actor, guess: string) {
    if (!(Hilo.GUESSES as readonly string[]).includes(guess)) throw new BadRequestException("Guess higher, lower, or skip the card.");
    const result = await this.house.step<Hilo.Round>(actor, "hilo", (state, draw) => {
      const next = Hilo.guess(state, guess as Hilo.Guess, draw);
      return { state: next, over: next.phase !== "PLAY", payoutCents: next.payout };
    }, Hilo.HiloError);
    return { round: Hilo.publicView(result.state), balance: result.balance };
  }

  async hiloCashOut(actor: Actor) {
    const result = await this.house.step<Hilo.Round>(actor, "hilo", (state) => {
      const next = Hilo.cashOut(state);
      return { state: next, over: true, payoutCents: next.payout };
    }, Hilo.HiloError);
    return { round: Hilo.publicView(result.state), balance: result.balance };
  }

  // ——— Tower ———

  async towerState(actor: Actor) {
    const [basics, open] = await Promise.all([this.house.basics(actor, "tower", Tower.BETS), this.house.openRound(actor.id, "tower")]);
    return {
      ...basics,
      recent: basics.recent.map((row) => ({ ...row, round: row.round ? publicRecord(row.round as unknown as Tower.Round & { game: string }) : null })),
      round: open ? Tower.publicView(open.state as unknown as Tower.Round) : null,
      game: { name: Tower.GAME_NAME, bets: Tower.BETS, floors: Tower.FLOORS, levels: Tower.LEVELS, shapes: Tower.LEVEL_SHAPE, ladders: Object.fromEntries(Tower.LEVELS.map((level) => [level, Tower.ladder(level)])), payoutRate: Tower.PAYOUT_RATE, maxWin: Tower.MAX_WIN },
    };
  }

  async towerStart(actor: Actor, bet: number, level: string) {
    if (!(Tower.LEVELS as readonly string[]).includes(level)) throw new BadRequestException("Pick easy, medium, hard or expert.");
    const result = await this.house.start(actor, "tower", bet, Tower.BETS, (cents, draw) => Tower.startRound(cents, level as Tower.Level, draw));
    return { round: Tower.publicView(result.state), balance: result.balance };
  }

  async towerClimb(actor: Actor, door: number) {
    const result = await this.house.step<Tower.Round>(actor, "tower", (state) => {
      const next = Tower.climb(state, door);
      return { state: next, over: next.phase !== "PLAY", payoutCents: next.payout };
    }, Tower.TowerError);
    return { round: Tower.publicView(result.state), balance: result.balance };
  }

  async towerCashOut(actor: Actor) {
    const result = await this.house.step<Tower.Round>(actor, "tower", (state) => {
      const next = Tower.cashOut(state);
      return { state: next, over: true, payoutCents: next.payout };
    }, Tower.TowerError);
    return { round: Tower.publicView(result.state), balance: result.balance };
  }

  // ——— Crash ———

  async crashState(actor: Actor) {
    // A round that has crashed (or cashed out by itself) since the last look is settled first.
    if (await this.house.openRound(actor.id, "crash")) await this.crashCheck(actor).catch(() => undefined);
    const [basics, open] = await Promise.all([this.house.basics(actor, "crash", Crash.BETS, 30), this.house.openRound(actor.id, "crash")]);
    const now = this.house.now();
    return {
      ...basics,
      round: open ? Crash.publicView(open.state as unknown as Crash.Round, now) : null,
      game: { name: Crash.GAME_NAME, bets: Crash.BETS, growth: Crash.GROWTH, minAuto: Crash.MIN_AUTO, maxMultiplier: Crash.MAX_MULTIPLIER, payoutRate: Crash.PAYOUT_RATE },
    };
  }

  async crashStart(actor: Actor, bet: number, auto: number | null) {
    let autoHundredths: number | null = null;
    if (auto !== null && auto !== undefined) {
      autoHundredths = Math.round(Number(auto) * 100);
      if (!Number.isFinite(autoHundredths) || autoHundredths < Crash.MIN_AUTO * 100 || autoHundredths > Crash.MAX_MULTIPLIER * 100) {
        throw new BadRequestException(`An automatic cash-out is from ${Crash.MIN_AUTO.toFixed(2)}× to ${Crash.MAX_MULTIPLIER}×.`);
      }
    }
    const result = await this.house.start(actor, "crash", bet, Crash.BETS, (cents, draw, now) => Crash.startRound(cents, autoHundredths, draw, now));
    // It may have crashed at 1.00× straight away: settled at once.
    const settled = Crash.advance(result.state, this.house.now());
    if (settled.phase !== "PLAY") return this.crashCheck(actor);
    return { round: Crash.publicView(result.state, this.house.now()), balance: result.balance };
  }

  /** Where the round stands now; one that has crashed, or reached its automatic cash-out, is settled. */
  async crashCheck(actor: Actor) {
    const result = await this.house.step<Crash.Round>(actor, "crash", (state, _draw, now) => {
      const next = Crash.advance(state, now);
      return { state: next, over: next.phase !== "PLAY", payoutCents: next.payout };
    }, Crash.CrashError, "There's no Crash round in play.");
    return { round: Crash.publicView(result.state, this.house.now()), balance: result.balance };
  }

  async crashCashOut(actor: Actor) {
    const result = await this.house.step<Crash.Round>(actor, "crash", (state, _draw, now) => {
      const next = Crash.cashOut(state, now);
      return { state: next, over: true, payoutCents: next.payout };
    }, Crash.CrashError, "There's no Crash round in play.");
    return { round: Crash.publicView(result.state, this.house.now()), balance: result.balance };
  }
}

/** A finished climb as shown in the history: everything, the traps included. */
function publicRecord(round: Tower.Round & { game: string }) {
  return Tower.publicView(round);
}
