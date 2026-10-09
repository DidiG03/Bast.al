import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BetStatus, Prisma, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";
import { startOfWeek } from "../time";
import { HierarchyService } from "../users/hierarchy.service";

const RECENT_LIMIT = 50;

/** Settled-bet and casino totals, as on the Commissions page: `net` = stakes - payouts. `casinoRounds` are the spins, hands and rounds among them. */
type Totals = { bets: number; casinoRounds: number; staked: number; paidOut: number; net: number };

/** Each casino play kind's game page key; a double or nothing counts with the slot it was won on. */
const GAME_OF_KIND: Record<string, string> = {
  SPIN: "slot",
  BOOK: "book",
  ROULETTE: "roulette",
  BLACKJACK: "blackjack",
  MINES: "mines",
  PENALTY: "penalty",
  PLINKO: "plinko",
  DICE: "dice",
  KENO: "keno",
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * What a Player is doing with the credit they were given: bets still open
 * and casino rounds still in play, recent results, each casino game over the
 * last 30 days, and their net result over a few periods (bets and casino
 * together). Visible to anyone above the Player in the hierarchy.
 */
@Injectable()
export class PlayerActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
  ) {}

  async activity(actor: Actor, playerId: string) {
    const player = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { id: true, username: true, role: true, status: true, balance: true, parent: { select: { username: true, role: true } } },
    });
    if (!player) throw new NotFoundException("User not found");
    if (!(await this.hierarchy.canActOn(actor, playerId)) || actor.id === playerId) {
      throw new ForbiddenException("This Player is outside your team");
    }
    if (player.role !== Role.PLAYER) throw new BadRequestException("Activity is only available for Players");

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const [thisWeek, last30Days, allTime, open, recent, inPlay, casino] = await Promise.all([
      this.totals(playerId, startOfWeek(now)),
      this.totals(playerId, thirtyDaysAgo),
      this.totals(playerId, null),
      this.prisma.bet.findMany({
        where: { playerId, status: BetStatus.OPEN },
        orderBy: { placedAt: "desc" },
        select: { id: true, description: true, odds: true, stake: true, placedAt: true },
      }),
      this.prisma.bet.findMany({
        where: { playerId, status: { not: BetStatus.OPEN } },
        orderBy: { settledAt: "desc" },
        take: RECENT_LIMIT,
        select: { id: true, description: true, odds: true, stake: true, payout: true, status: true, placedAt: true, settledAt: true },
      }),
      this.casinoInPlay(playerId),
      this.casinoByGame(playerId, thirtyDaysAgo),
    ]);

    return {
      player: {
        id: player.id,
        username: player.username,
        status: player.status,
        balance: Number(player.balance),
        parent: player.parent,
      },
      summary: { thisWeek, last30Days, allTime },
      open: {
        count: open.length,
        staked: round(open.reduce((sum, bet) => sum + Number(bet.stake), 0)),
        bets: open.map((bet) => ({ ...bet, stake: Number(bet.stake), odds: bet.odds === null ? null : Number(bet.odds) })),
        /** Casino rounds started and not finished: their stake is already out of the balance. Free spins cost nothing. */
        casino: inPlay,
      },
      /** Each casino game played in the last 30 days, most staked first. */
      casino,
      recent: recent.map((bet) => ({
        ...bet,
        stake: Number(bet.stake),
        payout: Number(bet.payout),
        odds: bet.odds === null ? null : Number(bet.odds),
      })),
    };
  }

  /** From the settlement journal, like the Commissions page: a correction counts on the day it was made. */
  private async totals(playerId: string, since: Date | null): Promise<Totals> {
    const where = { playerId, ...(since ? { createdAt: { gte: since } } : {}) };
    const [row, casinoRounds] = await Promise.all([
      this.prisma.settlementEntry.aggregate({ where, _sum: { bets: true, stake: true, payout: true } }),
      this.prisma.settlementEntry.count({ where: { ...where, casinoSpinId: { not: null } } }),
    ]);
    const staked = round(Number(row._sum.stake ?? 0));
    const paidOut = round(Number(row._sum.payout ?? 0));
    return { bets: row._sum.bets ?? 0, casinoRounds, staked, paidOut, net: round(staked - paidOut) };
  }

  /** The casino rounds the Player has started and not finished: a blackjack hand, a Mines or Penalty round, free spins. */
  private async casinoInPlay(playerId: string) {
    const [blackjack, mines, penalty, book, slot] = await Promise.all([
      this.prisma.blackjackHand.findUnique({ where: { playerId }, select: { staked: true, createdAt: true } }),
      this.prisma.minesRound.findUnique({ where: { playerId }, select: { staked: true, createdAt: true } }),
      this.prisma.penaltyRound.findUnique({ where: { playerId }, select: { staked: true, createdAt: true } }),
      this.prisma.casinoBookFeature.findUnique({ where: { playerId }, select: { bet: true, remaining: true, createdAt: true } }),
      this.prisma.casinoFreeSpins.findUnique({ where: { playerId }, select: { bet: true, remaining: true, updatedAt: true } }),
    ]);
    const rounds: Array<{ game: string; staked: number; freeSpins: number | null; startedAt: Date }> = [];
    if (blackjack) rounds.push({ game: "blackjack", staked: Number(blackjack.staked), freeSpins: null, startedAt: blackjack.createdAt });
    if (mines) rounds.push({ game: "mines", staked: Number(mines.staked), freeSpins: null, startedAt: mines.createdAt });
    if (penalty) rounds.push({ game: "penalty", staked: Number(penalty.staked), freeSpins: null, startedAt: penalty.createdAt });
    if (book) rounds.push({ game: "book", staked: 0, freeSpins: book.remaining, startedAt: book.createdAt });
    if (slot && slot.remaining > 0) rounds.push({ game: "slot", staked: 0, freeSpins: slot.remaining, startedAt: slot.updatedAt });
    return rounds;
  }

  /** Each casino game since `since`: rounds played (double or nothing guesses count with their slot), staked, paid out and the net, most staked first. */
  private async casinoByGame(playerId: string, since: Date) {
    const rows = await this.prisma.$queryRaw<Array<{ kind: string; rounds: bigint; staked: Prisma.Decimal | null; won: Prisma.Decimal | null; last: Date }>>`
      SELECT CASE WHEN kind = 'GAMBLE' AND gamble->>'game' = 'book' THEN 'BOOK' WHEN kind = 'GAMBLE' THEN 'SPIN' ELSE kind::text END AS kind,
        COUNT(*) FILTER (WHERE kind <> 'GAMBLE') AS rounds, SUM(stake) AS staked, SUM(win) AS won, MAX(created_at) AS last
      FROM casino_spins
      WHERE player_id = ${playerId} AND created_at >= ${since}
      GROUP BY 1
    `;
    return rows
      .map((row) => {
        const staked = round(Number(row.staked ?? 0));
        const paidOut = round(Number(row.won ?? 0));
        return { game: GAME_OF_KIND[row.kind] ?? "slot", rounds: Number(row.rounds), staked, paidOut, net: round(staked - paidOut), lastPlayed: row.last };
      })
      .sort((a, b) => b.staked - a.staked);
  }
}
