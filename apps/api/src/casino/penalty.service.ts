import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomInt } from "crypto";
import { Prisma, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { assertOnTeam } from "../bets/team";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { dayKey, startOfDay } from "../time";
import { UsersService } from "../users/users.service";
import { addToDailyLine, casinoClosedReason, maxStakeOf } from "./access";
import { BETS, DIRECTIONS, FULL_PRICE_GOALS, GAME_NAME, LATER_STEP, MAX_WIN, PAYOUT_RATE, PenaltyError, cashOut, kick, publicView, startRound, type Direction, type Round } from "./penalty";

const RECENT = 10;
/** A shootout nobody has touched for this long is cashed out, or refunded if no goal was scored. */
const IDLE_MS = 60 * 60_000;
const SWEEP_MS = 5 * 60_000;

/** Penalty has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `penalty_${playerId}_${dayKey(at)}`;
const dollars = (cents: number) => new Prisma.Decimal(cents).div(100);

const roundSelect = { id: true, bet: true, stake: true, win: true, penalty: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

function roundView(row: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>) {
  const round = row.penalty as Round | null;
  return round ? { id: row.id, ...publicView(round), createdAt: row.createdAt } : null;
}

type Tx = Prisma.TransactionClient;
type Team = { ownerId: string | null; managerId: string | null; ownerRate: Prisma.Decimal; managerRate: Prisma.Decimal };

/**
 * Penalty (see penalty.ts), played with the Player's Bast.al balance. A
 * shootout takes several kicks, so it's kept here between them (PenaltyRound)
 * until it ends. The stake leaves the balance when it starts. Cashing out,
 * or a save, pays and records it like a spin (a CasinoSpin, a settlement
 * journal row for Commissions, the day's ledger line). A shootout left alone
 * for an hour is cashed out at the goals already scored, or the stake comes
 * back if there were none.
 */
@Injectable()
export class PenaltyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PenaltyService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Where the keeper dives: crypto.randomInt unless a test sets its own. */
  draw: (below: number) => number = randomInt;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
  ) {}

  onModuleInit() {
    if (process.env.PENALTY_SWEEP_DISABLED === "true") return;
    this.timer = setInterval(() => void this.settleIdle().catch((error) => this.logger.error(error)), SWEEP_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The most one shootout can stake: the Player's max stake, or the top chip without one. */
  private async tableMax(playerId: string): Promise<number> {
    return (await maxStakeOf(this.prisma, playerId)) ?? BETS[BETS.length - 1];
  }

  /** The Player's shootout: whether they can play, the rules, the one in play (if any) and their last ones. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, open, recent] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.penaltyRound.findUnique({ where: { playerId: actor.id } }),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "PENALTY" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
    ]);
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      round: open ? publicView(open.state as unknown as Round) : null,
      recent: recent.map(roundView).filter((row): row is NonNullable<typeof row> => row !== null),
      game: { name: GAME_NAME, bets: BETS, directions: DIRECTIONS, payoutRate: PAYOUT_RATE, fullPriceGoals: FULL_PRICE_GOALS, laterStep: LATER_STEP, maxWin: MAX_WIN },
    };
  }

  /** Starts a shootout at `bet` dollars. */
  async start(actor: Actor, bet: number) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const cents = Math.round(bet * 100);
    if (!Number.isFinite(bet) || Math.abs(cents - bet * 100) > 1e-6 || !(BETS as readonly number[]).includes(bet)) {
      throw new BadRequestException("Bets are made in chips of $0.50 and up.");
    }
    const tableMax = await this.tableMax(actor.id);
    if (bet > tableMax) throw new BadRequestException(`The most you can bet on one round is $${tableMax.toFixed(2)}`);
    const team = await assertOnTeam(this.prisma, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      if (await tx.penaltyRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish the Penalty round you're playing first.");
      }
      if (await tx.minesRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish the Mines round you're playing first.");
      }
      if (await tx.blackjackHand.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish the hand you're playing first.");
      }
      if (await tx.casinoBookFeature.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish your Book of Ra free spins first.");
      }
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet);
      const round = startRound(cents);
      await this.take(tx, actor.id, round.bet);
      const now = new Date();
      await this.addToLedger(tx, actor.id, -round.bet, now, true);
      await tx.penaltyRound.create({
        data: { playerId: actor.id, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, staked: dollars(round.bet), state: round as unknown as Prisma.InputJsonValue },
      });
      return { round, balance: await this.balanceIn(tx, actor.id) };
    });
    return this.after(actor.id, result.round, result.balance, result.round.bet);
  }

  /** Aims one kick in the shootout being played. */
  async shoot(actor: Actor, aim: Direction) {
    return this.step(actor, (round) => kick(round, aim, this.draw));
  }

  /** Cashes out the shootout being played. */
  async collect(actor: Actor) {
    return this.step(actor, (round) => cashOut(round));
  }

  /** One kick, or the cash-out. The stake is already down, so this only pays when the shootout ends. */
  private async step(actor: Actor, apply: (round: Round) => Round) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      const openRow = await tx.penaltyRound.findUnique({ where: { playerId: actor.id } });
      if (!openRow) throw new BadRequestException("There's no Penalty round in play. Start one first.");
      let round: Round;
      try {
        round = apply(openRow.state as unknown as Round);
      } catch (error) {
        if (error instanceof PenaltyError) throw new BadRequestException(error.message);
        throw error;
      }
      const now = new Date();
      if (round.phase === "PLAY") {
        await tx.penaltyRound.update({ where: { playerId: actor.id }, data: { state: round as unknown as Prisma.InputJsonValue } });
      } else {
        await tx.penaltyRound.delete({ where: { playerId: actor.id } });
        await this.settle(tx, actor.id, openRow, round, now);
      }
      return { round, balance: await this.balanceIn(tx, actor.id) };
    });
    return this.after(actor.id, result.round, result.balance, 0);
  }

  /**
   * Finishes every shootout nobody has touched for an hour, so no money stays
   * riding. One with a goal is cashed out; one with none has its stake
   * returned, and it isn't recorded as a round.
   */
  async settleIdle(now = new Date()) {
    const idle = await this.prisma.penaltyRound.findMany({ where: { updatedAt: { lt: new Date(now.getTime() - IDLE_MS) } }, select: { playerId: true } });
    for (const { playerId } of idle) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${playerId} FOR UPDATE`;
        const openRow = await tx.penaltyRound.findUnique({ where: { playerId } });
        if (!openRow || openRow.updatedAt.getTime() >= now.getTime() - IDLE_MS) return;
        const round = openRow.state as unknown as Round;
        await tx.penaltyRound.delete({ where: { playerId } });
        if (round.goals.length === 0) await this.refund(tx, playerId, round.bet, new Date());
        else await this.settle(tx, playerId, openRow, cashOut(round), new Date());
      });
      await this.realtime.publishBalances([playerId]);
    }
    return idle.length;
  }

  /** Takes `cents` from the balance, if it's there. */
  private async take(tx: Tx, playerId: string, cents: number) {
    const amount = dollars(cents);
    const moved = await tx.user.updateMany({ where: { id: playerId, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
    if (moved.count === 0) throw new BadRequestException("Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.");
  }

  /** Puts an unplayed shootout's stake back and drops it from the day's line when nothing else was played. */
  private async refund(tx: Tx, playerId: string, cents: number, now: Date) {
    const amount = dollars(cents);
    await tx.user.update({ where: { id: playerId }, data: { balance: { increment: amount } } });
    const lineId = ledgerLineId(playerId, now);
    const line = await tx.balanceTransaction.findUnique({ where: { id: lineId }, select: { amount: true } });
    if (!line) return;
    const next = line.amount.add(amount);
    const played = await tx.casinoSpin.count({ where: { playerId, kind: "PENALTY", createdAt: { gte: startOfDay(now) } } });
    if (next.isZero() && played === 0) await tx.balanceTransaction.delete({ where: { id: lineId } });
    else await this.addToLedger(tx, playerId, cents, now, false);
  }

  /** Pays a finished shootout and records it: the casino round, the journal row for Commissions, and the ledger. */
  private async settle(tx: Tx, playerId: string, team: Team, round: Round, now: Date) {
    const stake = dollars(round.bet);
    const win = dollars(round.payout);
    if (win.greaterThan(0)) await tx.user.update({ where: { id: playerId }, data: { balance: { increment: win } } });
    const spin = await tx.casinoSpin.create({
      data: {
        kind: "PENALTY",
        playerId,
        ownerId: team.ownerId,
        managerId: team.managerId,
        ownerRate: team.ownerRate,
        managerRate: team.managerRate,
        bet: stake,
        stake,
        win,
        grid: [],
        stops: [],
        lines: {},
        penalty: round as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.settlementEntry.create({
      data: { casinoSpinId: spin.id, playerId, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, bets: 0, stake, payout: win, createdAt: now },
    });
    await this.addToLedger(tx, playerId, round.payout, now, false);
  }

  /** Adds money moved (cents, signed) to the day's single "Penalty" line in the Player's ledger. */
  private async addToLedger(tx: Tx, playerId: string, cents: number, now: Date, inPlay: boolean) {
    const played = await tx.casinoSpin.count({ where: { playerId, kind: "PENALTY", createdAt: { gte: startOfDay(now) } } });
    const rounds = played + (inPlay ? 1 : 0);
    const reason = rounds === 1 ? "Penalty: 1 round" : `Penalty: ${rounds} rounds`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, dollars(cents), reason, now);
  }

  private async balanceIn(tx: Tx, playerId: string) {
    return Number((await tx.user.findUniqueOrThrow({ where: { id: playerId }, select: { balance: true } })).balance);
  }

  /** After a kick: the live balance, a low-balance alert when the stake went down, and the shootout as the Player sees it. */
  private async after(playerId: string, round: Round, balance: number, putDown: number) {
    await this.realtime.publishBalances([playerId]);
    // The stake leaves as the shootout starts. A save later doesn't take anything more, so it isn't a second alert.
    if (putDown > 0) await this.users.alertLowBalance(playerId, putDown / 100);
    return { round: publicView(round), balance };
  }
}
