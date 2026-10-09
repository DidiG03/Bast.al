import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { randomInt } from "crypto";
import { Prisma, Role } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { assertOnTeam } from "../bets/team";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { dayKey, startOfDay } from "../time";
import { UsersService } from "../users/users.service";
import { addToDailyLine, casinoClosedReason, maxStakeOf } from "./access";
import { CHIPS, GAME_NAME, MAX_SPOTS, PAYOUT_RATE, RED_NUMBERS, TABLE_MAX, WHEEL, colorOf, invalidBets, label, settle, spinWheel, type PlacedBet } from "./roulette";

/** Rounds in the Player's recent list, and numbers in the strip of past results. */
const RECENT = 10;
const HISTORY = 16;

/** Roulette has its own line per Player per day in their balance ledger, next to the slot's. */
const ledgerLineId = (playerId: string, at: Date) => `roulette_${playerId}_${dayKey(at)}`;

const roundSelect = { id: true, bet: true, win: true, stops: true, roulette: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { number: number; bets: Array<{ spot: string; amount: number; win: number }> };

function roundView(round: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>) {
  const stored = round.roulette as Stored | null;
  const number = stored?.number ?? 0;
  return {
    id: round.id,
    number,
    label: label(number),
    color: colorOf(number),
    staked: Number(round.bet),
    win: Number(round.win),
    bets: (stored?.bets ?? []).map(({ spot, amount, win }) => ({ spot, amount, win })),
    createdAt: round.createdAt,
  };
}

/**
 * European roulette (see roulette.ts), played with the Player's Bast.al
 * balance like the slot: the number is drawn here, never in the browser,
 * and a round moves money the same way as a spin, in one transaction (the
 * balance, a settlement journal row for Commissions, and the day's ledger
 * line). All the chips on the table together are one stake: the Player's
 * max stake applies to them (TABLE_MAX when there's none), and so do the
 * daily loss limit and the Casino's switches.
 */
@Injectable()
export class RouletteService {
  /** Where the wheel stops (an index into WHEEL): crypto.randomInt unless a test sets its own. */
  draw: (pockets: number) => number = randomInt;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The most this Player can have on the table in one round: their max stake, or TABLE_MAX without one. */
  private async tableMax(playerId: string): Promise<number> {
    return (await maxStakeOf(this.prisma, playerId)) ?? TABLE_MAX;
  }

  /** The Player's roulette table: whether they can play, the rules, their last rounds and the last numbers. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, recent] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "ROULETTE" }, orderBy: { createdAt: "desc" }, take: HISTORY, select: roundSelect }),
    ]);
    const rounds = recent.map(roundView);
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      recent: rounds.slice(0, RECENT),
      /** The Player's last numbers, newest first. */
      history: rounds.map(({ number, label, color }) => ({ number, label, color })),
      game: {
        name: GAME_NAME,
        wheel: WHEEL,
        red: RED_NUMBERS,
        chips: CHIPS,
        maxSpots: MAX_SPOTS,
        payoutRate: PAYOUT_RATE,
      },
    };
  }

  /** One round: the chips on the table, the wheel, and the pay-out. */
  async spin(actor: Actor, input: PlacedBet[], ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const bets = input.map((bet) => ({ spot: String(bet.spot), amount: Number(bet.amount) }));
    const invalid = invalidBets(bets);
    if (invalid) throw new BadRequestException(invalid);
    const staked = settle(bets, 0).staked;
    const tableMax = await this.tableMax(actor.id);
    if (staked > tableMax) throw new BadRequestException(`The most you can have on the table in one spin is ${tableMax.toFixed(2)} ALL`);
    const team = await assertOnTeam(this.prisma, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      // One round at a time per Player, and none while a slot spin or a bet is going through.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, staked, 0, tx);

      const { stop, number } = spinWheel(this.draw);
      const outcome = settle(bets, number);
      const stake = new Prisma.Decimal(outcome.staked);
      const win = new Prisma.Decimal(outcome.win);
      const net = win.sub(stake);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: stake } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for these chips. Take some off, or ask your Manager for a top-up.");

      const now = new Date();
      const round = await tx.casinoSpin.create({
        data: {
          kind: "ROULETTE",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: stake,
          stake,
          win,
          grid: [],
          stops: [stop],
          lines: {},
          roulette: { number, bets: outcome.bets.map(({ spot, amount, win }) => ({ spot, amount, win })) } satisfies Stored,
          createdAt: now,
        },
        select: roundSelect,
      });
      // Counts in the team's results and commission like a settled bet (0 bets, the stake and the win).
      await tx.settlementEntry.create({
        data: { casinoSpinId: round.id, playerId: actor.id, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, bets: 0, stake, payout: win, createdAt: now },
      });
      await this.addToLedger(tx, actor.id, net, now);
      const balance = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } })).balance;
      return { round, stop, number, outcome, win, net, balance };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    if (result.outcome.bets.some((bet) => bet.win > 0 && bet.numbers.length === 1 && bet.amount >= 10)) {
      // Worth a line in the audit log: a single number hit for 10 ALL or more.
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.round.id, game: "roulette", number: label(result.number), win: Number(result.win) } });
    }
    return {
      round: roundView(result.round),
      /** Where the wheel stopped: an index into WHEEL, so the ball lands in the right pocket. */
      stop: result.stop,
      number: result.number,
      label: label(result.number),
      color: colorOf(result.number),
      staked: result.outcome.staked,
      win: result.outcome.win,
      /** The spots that won, and what each paid (its stake included). */
      winners: result.outcome.bets.filter((bet) => bet.win > 0).map(({ spot, amount, win }) => ({ spot, amount, win })),
      balance: Number(result.balance),
    };
  }

  /** Adds a round to the day's single "Roulette" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const rounds = await tx.casinoSpin.count({ where: { playerId, kind: "ROULETTE", createdAt: { gte: startOfDay(now) } } });
    const reason = rounds === 1 ? "Roulette: 1 spin" : `Roulette: ${rounds} spins`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
