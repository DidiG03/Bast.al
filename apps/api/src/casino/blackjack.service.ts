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
import { CHIPS, GAME_NAME, MoveError, PAYOUT_RATE, TABLE_MAX, act, deal, newShoe, paidOut, publicView, staked, standAll, type Action, type Round } from "./blackjack";

const RECENT = 10;
/** A round nobody has touched for this long is stood and settled. */
const IDLE_MS = 60 * 60_000;
const SWEEP_MS = 5 * 60_000;

/** Blackjack has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `blackjack_${playerId}_${dayKey(at)}`;
const dollars = (cents: number) => new Prisma.Decimal(cents).div(100);

const roundSelect = { id: true, bet: true, stake: true, win: true, blackjack: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

function roundView(row: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>) {
  const round = row.blackjack as Round | null;
  const view = round ? publicView(round) : null;
  return {
    id: row.id,
    bet: Number(row.bet),
    staked: Number(row.stake),
    win: Number(row.win),
    dealer: view?.dealer ?? [],
    dealerTotal: view?.dealerTotal ?? 0,
    hands: (view?.hands ?? []).map(({ cards, total, blackjack, result }) => ({ cards, total, blackjack, result })),
    createdAt: row.createdAt,
  };
}

type Tx = Prisma.TransactionClient;
type Team = { ownerId: string | null; managerId: string | null; ownerRate: Prisma.Decimal; managerRate: Prisma.Decimal };

/**
 * Blackjack (see blackjack.ts), played with the Player's Bast.al balance.
 * Unlike a spin, a round takes several requests, so it's kept here between
 * them (BlackjackHand), with the shoe, until it ends. Money moves when it's
 * put down: the bet on the deal, and a double, a split or insurance when
 * the Player makes that move, each checked against the balance and the daily
 * loss limit. When the round ends it's paid and recorded like a spin (a
 * CasinoSpin, a settlement journal row for Commissions, the day's ledger
 * line). A round left alone for an hour is stood and settled.
 */
@Injectable()
export class BlackjackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlackjackService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Shuffles: crypto.randomInt unless a test sets its own. */
  draw: (below: number) => number = randomInt;
  /** Lets a test stack the shoe. */
  shoe: () => Round["shoe"] = () => newShoe(this.draw);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
  ) {}

  onModuleInit() {
    if (process.env.BLACKJACK_SWEEP_DISABLED === "true") return;
    this.timer = setInterval(() => void this.settleIdle().catch((error) => this.logger.error(error)), SWEEP_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The most a first bet can be: the Player's max stake, or TABLE_MAX without one. */
  private async tableMax(playerId: string): Promise<number> {
    return (await maxStakeOf(this.prisma, playerId)) ?? TABLE_MAX;
  }

  /** The Player's table: whether they can play, the rules, the round in play (if any) and their last rounds. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, open, recent] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.blackjackHand.findUnique({ where: { playerId: actor.id } }),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "BLACKJACK" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
    ]);
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      /** The round still being played, to carry on with. */
      round: open ? publicView(open.state as unknown as Round) : null,
      recent: recent.map(roundView),
      game: { name: GAME_NAME, chips: CHIPS, payoutRate: PAYOUT_RATE },
    };
  }

  /** Deals a new round for `bet` dollars. */
  async deal(actor: Actor, bet: number) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const cents = Math.round(bet * 100);
    if (!Number.isFinite(bet) || Math.abs(cents - bet * 100) > 1e-6 || cents <= 0 || cents % Math.round(CHIPS[0] * 100) !== 0) {
      throw new BadRequestException(`Bets are made in chips of $${CHIPS[0].toFixed(2)} and up.`);
    }
    const tableMax = await this.tableMax(actor.id);
    if (bet > tableMax) throw new BadRequestException(`The most you can bet on one hand is $${tableMax.toFixed(2)}`);
    const team = await assertOnTeam(this.prisma, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      if (await tx.blackjackHand.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish the hand you're playing first.");
      }
      if (await tx.minesRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish the Mines round you're playing first.");
      }
      if (await tx.penaltyRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) {
        throw new BadRequestException("Finish the Penalty round you're playing first.");
      }
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet);
      const round = deal(cents, this.shoe());
      await this.take(tx, actor.id, staked(round), "Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.");
      const now = new Date();
      await this.addToLedger(tx, actor.id, -staked(round), now, round.phase !== "DONE");
      if (round.phase === "DONE") await this.settle(tx, actor.id, team, round, now);
      else {
        await tx.blackjackHand.create({
          data: { playerId: actor.id, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, staked: dollars(staked(round)), state: round as unknown as Prisma.InputJsonValue },
        });
      }
      return { round, balance: await this.balanceIn(tx, actor.id) };
    });
    return this.after(actor.id, result.round, result.balance, staked(result.round));
  }

  /** One move in the round being played. */
  async act(actor: Actor, action: Action) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      const open = await tx.blackjackHand.findUnique({ where: { playerId: actor.id } });
      if (!open) throw new BadRequestException("There's no hand in play. Deal first.");
      const before = open.state as unknown as Round;
      let round: Round;
      try {
        round = act(before, action);
      } catch (error) {
        if (error instanceof MoveError) throw new BadRequestException(error.message);
        throw error;
      }
      // A double, a split or insurance puts more down.
      const extra = staked(round) - staked(before);
      if (extra > 0) {
        await this.limits.assertCanPlace(actor.id, extra / 100);
        await this.take(tx, actor.id, extra, "Your balance is too low for that. You can still hit or stand.");
      }
      const now = new Date();
      if (extra > 0) await this.addToLedger(tx, actor.id, -extra, now, round.phase !== "DONE");
      if (round.phase === "DONE") {
        await tx.blackjackHand.delete({ where: { playerId: actor.id } });
        await this.settle(tx, actor.id, open, round, now);
      } else {
        await tx.blackjackHand.update({ where: { playerId: actor.id }, data: { staked: dollars(staked(round)), state: round as unknown as Prisma.InputJsonValue } });
      }
      return { round, extra, balance: await this.balanceIn(tx, actor.id) };
    });
    return this.after(actor.id, result.round, result.balance, result.extra);
  }

  /** Stands and settles every round nobody has touched for an hour, so no money stays riding for ever. */
  async settleIdle(now = new Date()) {
    const idle = await this.prisma.blackjackHand.findMany({ where: { updatedAt: { lt: new Date(now.getTime() - IDLE_MS) } }, select: { playerId: true } });
    for (const { playerId } of idle) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${playerId} FOR UPDATE`;
        const open = await tx.blackjackHand.findUnique({ where: { playerId } });
        if (!open || open.updatedAt.getTime() >= now.getTime() - IDLE_MS) return;
        const round = standAll(open.state as unknown as Round);
        await tx.blackjackHand.delete({ where: { playerId } });
        await this.settle(tx, playerId, open, round, new Date());
      });
      await this.realtime.publishBalances([playerId]);
    }
    return idle.length;
  }

  /** Takes `cents` from the balance, if it's there. */
  private async take(tx: Tx, playerId: string, cents: number, tooLow: string) {
    const amount = dollars(cents);
    const moved = await tx.user.updateMany({ where: { id: playerId, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
    if (moved.count === 0) throw new BadRequestException(tooLow);
  }

  /** Pays a finished round and records it: the casino round, the journal row for Commissions, and the ledger. */
  private async settle(tx: Tx, playerId: string, team: Team, round: Round, now: Date) {
    const stake = dollars(staked(round));
    const win = dollars(paidOut(round));
    if (win.greaterThan(0)) await tx.user.update({ where: { id: playerId }, data: { balance: { increment: win } } });
    const spin = await tx.casinoSpin.create({
      data: {
        kind: "BLACKJACK",
        playerId,
        ownerId: team.ownerId,
        managerId: team.managerId,
        ownerRate: team.ownerRate,
        managerRate: team.managerRate,
        bet: dollars(round.bet),
        stake,
        win,
        grid: [],
        stops: [],
        lines: {},
        blackjack: round as unknown as Prisma.InputJsonValue,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.settlementEntry.create({
      data: { casinoSpinId: spin.id, playerId, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, bets: 0, stake, payout: win, createdAt: now },
    });
    await this.addToLedger(tx, playerId, paidOut(round), now, false);
  }

  /** Adds money moved (cents, signed) to the day's single "Blackjack" line in the Player's ledger. */
  private async addToLedger(tx: Tx, playerId: string, cents: number, now: Date, inPlay: boolean) {
    const played = await tx.casinoSpin.count({ where: { playerId, kind: "BLACKJACK", createdAt: { gte: startOfDay(now) } } });
    const hands = played + (inPlay ? 1 : 0);
    const reason = hands === 1 ? "Blackjack: 1 hand" : `Blackjack: ${hands} hands`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, dollars(cents), reason, now);
  }

  private async balanceIn(tx: Tx, playerId: string) {
    return Number((await tx.user.findUniqueOrThrow({ where: { id: playerId }, select: { balance: true } })).balance);
  }

  /** After a deal or a move: the live balance, a low-balance alert when money went down, and the round as the Player sees it. */
  private async after(playerId: string, round: Round, balance: number, putDown: number) {
    await this.realtime.publishBalances([playerId]);
    const net = round.phase === "DONE" ? paidOut(round) - putDown : -putDown;
    if (net < 0) await this.users.alertLowBalance(playerId, -net / 100);
    return { round: publicView(round), balance };
  }
}
