import { BadRequestException, Injectable } from "@nestjs/common";
import { Actor } from "../auth/permissions";
import * as Baccarat from "./baccarat";
import * as Candy from "./candy";
import * as Crash from "./crash";
import * as Hilo from "./hilo";
import { HouseService } from "./house.service";
import * as Tower from "./tower";
import * as Wheel from "./wheel";

/**
 * Money Wheel, Baccarat, Hi-Lo, Tower, Crash and Candy Cascade: each game's rules (in its
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
    return { ...(await this.house.basics(actor, "wheel", Wheel.BETS)), game: { name: Wheel.GAME_NAME, bets: Wheel.BETS, risks: Wheel.RISKS, wheels: Object.fromEntries(Wheel.RISKS.map((risk) => [risk, Wheel.WHEELS[risk].map((value) => value / 100)])) } };
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

  // ——— Candy Cascade ———

  async candyState(actor: Actor) {
    const basics = await this.house.basics(actor, "candy", Candy.BETS);
    return {
      ...basics,
      // The history only needs each round's headline, not every board it went through.
      recent: basics.recent.map((row) => {
        const round = row.round as { win?: number; freeSpins?: number; capped?: boolean } | null;
        return { ...row, round: round ? { game: "candy" as const, win: round.win ?? 0, freeSpins: round.freeSpins ?? 0, capped: round.capped ?? false } : null };
      }),
      game: {
        name: Candy.GAME_NAME,
        bets: Candy.BETS,
        columns: Candy.COLUMNS,
        rows: Candy.ROWS,
        paying: Candy.PAYING,
        scatter: Candy.SCATTER,
        minCount: Candy.MIN_COUNT,
        /** What 8–9, 10–11 and 12 or more of each candy pay, in times the stake. */
        pays: Object.fromEntries(Candy.PAYING.map((symbol) => [symbol, Candy.PAYS[symbol].map((pay) => pay / 100)])),
        /** Lollipops anywhere: 4, 5 and 6 or more, in times the stake. */
        scatterPays: { 4: Candy.SCATTER_PAYS[4] / 100, 5: Candy.SCATTER_PAYS[5] / 100, 6: Candy.SCATTER_PAYS[6] / 100 },
        freeSpins: Candy.FREE_SPINS,
        moreFreeSpins: Candy.MORE_FREE_SPINS,
        scattersForFree: Candy.SCATTERS_FOR_FREE,
        scattersForMore: Candy.SCATTERS_FOR_MORE,
        multipliers: Candy.MULTIPLIERS.map(([value]) => value),
        maxWin: Candy.MAX_WIN,
      },
    };
  }

  /** A paid spin with every free spin it gives, settled at once; the page plays them back from what this returns. */
  async candySpin(actor: Actor, bet: number) {
    let round: Candy.Round | null = null;
    const result = await this.house.instant(actor, "candy", bet, Candy.BETS, (stakeCents, draw) => {
      round = Candy.play(draw);
      return { payoutCents: Candy.winCents(stakeCents, round.win), record: Candy.record(round) };
    });
    const played = round as unknown as Candy.Round;
    return { id: result.id, balance: result.balance, bet, win: Candy.winCents(Math.round(bet * 100), played.win) / 100, round: Candy.record(played) };
  }

  // ——— Baccarat ———

  async baccaratState(actor: Actor) {
    return { ...(await this.house.basics(actor, "baccarat", Baccarat.BETS)), game: { name: Baccarat.GAME_NAME, bets: Baccarat.BETS, sides: Baccarat.SIDES } };
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
    return { ...basics, round: open ? Hilo.publicView(open.state as unknown as Hilo.Round) : null, game: { name: Hilo.GAME_NAME, bets: Hilo.BETS, maxWin: Hilo.MAX_WIN } };
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
      game: { name: Tower.GAME_NAME, bets: Tower.BETS, floors: Tower.FLOORS, levels: Tower.LEVELS, shapes: Tower.LEVEL_SHAPE, ladders: Object.fromEntries(Tower.LEVELS.map((level) => [level, Tower.ladder(level)])), maxWin: Tower.MAX_WIN },
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
      game: { name: Crash.GAME_NAME, bets: Crash.BETS, growth: Crash.GROWTH, minAuto: Crash.MIN_AUTO, maxMultiplier: Crash.MAX_MULTIPLIER },
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
