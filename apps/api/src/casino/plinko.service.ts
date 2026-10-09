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
import { BETS, GAME_NAME, MAX_MULTIPLIER, PAYOUT_RATE, PAY_TABLES, RISKS, ROWS, dropBall, isRisk, isRows, payoutRate, winCents, type Risk, type Rows } from "./plinko";

/** Balls in the Player's recent list. */
const RECENT = 10;
/** A ball paying this many times its stake or more goes in the audit log. */
const BIG_WIN = 100;

/** Plinko has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `plinko_${playerId}_${dayKey(at)}`;

const roundSelect = { id: true, bet: true, win: true, plinko: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { rows: Rows; risk: Risk; path: number[]; bucket: number; multiplier: number };

function roundView(round: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>) {
  const stored = round.plinko as Stored | null;
  return {
    id: round.id,
    rows: stored?.rows ?? 16,
    risk: stored?.risk ?? "LOW",
    path: stored?.path ?? [],
    bucket: stored?.bucket ?? 0,
    multiplier: stored?.multiplier ?? 0,
    bet: Number(round.bet),
    win: Number(round.win),
    createdAt: round.createdAt,
  };
}

/**
 * Plinko (see plinko.ts), played with the Player's Bast.al balance like
 * roulette: the ball's path is drawn here, never in the browser, and a ball
 * moves money in one transaction (the balance, a settlement journal row for
 * Commissions, and the day's ledger line). The Player's max stake, the
 * daily loss limit and the Casino's switches apply to every ball.
 */
@Injectable()
export class PlinkoService {
  /** Which way the ball goes at each peg (0 or 1): crypto.randomInt unless a test sets its own. */
  draw: (sides: number) => number = randomInt;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The most one ball can cost this Player: their max stake, or the top chip without one. */
  private async tableMax(playerId: string): Promise<number> {
    const top = BETS[BETS.length - 1];
    const max = await maxStakeOf(this.prisma, playerId);
    return max === null ? top : Math.min(max, top);
  }

  /** The Player's Plinko board: whether they can play, the pay tables, their last balls. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, recent] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "PLINKO" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
    ]);
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      recent: recent.map(roundView),
      game: {
        name: GAME_NAME,
        bets: BETS,
        rows: ROWS,
        risks: RISKS,
        /** Every bucket's multiplier, left to right, by rows and then risk. */
        pays: PAY_TABLES,
        /** What each board pays back on average, in percent, by rows and then risk. */
        payoutRates: Object.fromEntries(ROWS.map((rows) => [rows, Object.fromEntries(RISKS.map((risk) => [risk, payoutRate(rows, risk)]))])),
        payoutRate: PAYOUT_RATE,
        maxWin: MAX_MULTIPLIER,
      },
    };
  }

  /** One ball: the stake, the path down the pegs, and the pay-out. */
  async drop(actor: Actor, betInput: number, rowsInput: number, riskInput: string, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const bet = Number(betInput);
    if (!(BETS as readonly number[]).includes(bet)) throw new BadRequestException("Pick one of the stakes shown for a ball.");
    if (!isRows(rowsInput)) throw new BadRequestException("A board has 8, 12 or 16 rows.");
    if (!isRisk(riskInput)) throw new BadRequestException("Pick a risk: low, medium or high.");
    const rows = rowsInput;
    const risk = riskInput;
    const tableMax = await this.tableMax(actor.id);
    if (bet > tableMax) throw new BadRequestException(`The most a ball can cost you is ${tableMax.toFixed(2)} ALL`);
    const team = await assertOnTeam(this.prisma, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      // One ball at a time per Player, and none while a slot spin or a bet is going through.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet, 0, tx);

      const ball = dropBall(rows, risk, this.draw);
      const stakeCents = Math.round(bet * 100);
      const stake = new Prisma.Decimal(stakeCents).div(100);
      const win = new Prisma.Decimal(winCents(stakeCents, ball.multiplier)).div(100);
      const net = win.sub(stake);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: stake } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this ball. Pick a smaller stake, or ask your Manager for a top-up.");

      const now = new Date();
      const round = await tx.casinoSpin.create({
        data: {
          kind: "PLINKO",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: stake,
          stake,
          win,
          grid: [],
          stops: [ball.bucket],
          lines: {},
          plinko: { rows, risk, path: ball.path, bucket: ball.bucket, multiplier: ball.multiplier } satisfies Stored,
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
      return { round, ball, net, balance };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    if (result.ball.multiplier >= BIG_WIN) {
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.round.id, game: "plinko", rows, risk, multiplier: result.ball.multiplier, win: Number(result.round.win) } });
    }
    return { round: roundView(result.round), balance: Number(result.balance) };
  }

  /** Adds a ball to the day's single "Plinko" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const balls = await tx.casinoSpin.count({ where: { playerId, kind: "PLINKO", createdAt: { gte: startOfDay(now) } } });
    const reason = balls === 1 ? "Plinko: 1 ball" : `Plinko: ${balls} balls`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
