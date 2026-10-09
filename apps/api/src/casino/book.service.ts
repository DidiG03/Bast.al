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
import {
  BETS,
  BOOK,
  FREE_SPINS,
  GAME_NAME,
  LINES,
  LINE_PAYS,
  LINE_SHAPES,
  MAX_WIN,
  PAYING,
  PAYOUT_RATE,
  REELS,
  ROWS,
  SCATTER_PAYS,
  SYMBOLS,
  drawSpecial,
  minToPay,
  spin as playSpin,
  type BookSymbol,
  type Draw,
  type Spin,
} from "./book";
import { canGamble, gambleView } from "./casino.service";
import { GAMBLE_LIMIT, GAMBLE_STEPS } from "./game";

const RECENT = 10;

const money = (value: Prisma.Decimal | number) => `${Number(value).toFixed(2)} ALL`;

/** Book of Ra has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `book_${playerId}_${dayKey(at)}`;

/** Line bets (a tenth of the bet) in dollars, rounded down to the cent. */
const inMoney = (bet: Prisma.Decimal, lineBets: number) => bet.div(LINES).mul(lineBets).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);

const spinSelect = { id: true, bet: true, stake: true, win: true, free: true, freeSpinsWon: true, grid: true, lines: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { special?: BookSymbol | null };

function spinView(row: Prisma.CasinoSpinGetPayload<{ select: typeof spinSelect }>) {
  return {
    id: row.id,
    bet: Number(row.bet),
    stake: Number(row.stake),
    win: Number(row.win),
    free: row.free,
    freeSpinsWon: row.freeSpinsWon,
    special: (row.lines as Stored | null)?.special ?? null,
    createdAt: row.createdAt,
  };
}

/** A round of free spins as the Player sees it. */
function featureView(row: { bet: Prisma.Decimal; special: string; remaining: number; played: number; won: Prisma.Decimal } | null) {
  if (!row) return null;
  return { bet: Number(row.bet), special: row.special as BookSymbol, remaining: row.remaining, played: row.played, won: Number(row.won) };
}

/** A past spin's grid to rest the reels on. */
function currentGrid(grid: Prisma.JsonValue | undefined): BookSymbol[][] | null {
  if (!Array.isArray(grid) || grid.length !== REELS) return null;
  const known = new Set<string>(SYMBOLS);
  return grid.every((column) => Array.isArray(column) && column.length === ROWS && column.every((symbol) => typeof symbol === "string" && known.has(symbol))) ? (grid as BookSymbol[][]) : null;
}

/**
 * Book of Ra (see book.ts), played with the Player's Bast.al balance like
 * the other slot: every spin is decided here and moves money in one
 * transaction (the balance, a settlement journal row for Commissions, the
 * day's "Book of Ra" ledger line). A round of free spins is kept between
 * requests (CasinoBookFeature); each free spin costs nothing and pays into
 * the balance as it plays. A win, or a whole round of free spins once it
 * ends, can go to double or nothing (CasinoService.gamble).
 */
@Injectable()
export class BookService {
  /** Where the reels stop and which symbol is special: crypto.randomInt unless a test sets its own. */
  draw: Draw = randomInt;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The Player's Book of Ra: whether they can play, the rules, a round of free spins in progress, their last spins. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, maxStake, feature, recent, gamble] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      maxStakeOf(this.prisma, actor.id),
      this.prisma.casinoBookFeature.findUnique({ where: { playerId: actor.id } }),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "BOOK" }, orderBy: { createdAt: "desc" }, take: RECENT, select: spinSelect }),
      this.prisma.casinoGamble.findUnique({ where: { playerId: actor.id } }),
    ]);
    return {
      closed,
      balance: Number(player.balance),
      maxStake,
      grid: currentGrid(recent[0]?.grid),
      feature: featureView(feature),
      gamble: gamble?.game === "book" ? gambleView(gamble) : null,
      recent: recent.map(spinView),
      game: {
        name: GAME_NAME,
        reels: REELS,
        rows: ROWS,
        lines: LINES,
        bets: BETS,
        symbols: SYMBOLS,
        book: BOOK,
        paying: PAYING,
        lineShapes: LINE_SHAPES,
        /** In line bets (a tenth of the bet): [2, 3, 4, 5] of a kind; 0 doesn't pay. */
        linePays: LINE_PAYS,
        /** Books anywhere, in times the whole bet. */
        scatterPays: SCATTER_PAYS,
        /** How many reels each symbol must be on to expand and pay in free spins. */
        expandsFrom: Object.fromEntries(PAYING.map((symbol) => [symbol, minToPay(symbol)])),
        freeSpins: FREE_SPINS,
        maxWin: MAX_WIN,
        payoutRate: PAYOUT_RATE,
        gambleSteps: GAMBLE_STEPS,
        gambleLimit: GAMBLE_LIMIT,
      },
    };
  }

  /**
   * One spin. With a round of free spins in progress it's the next free one,
   * at the bet that started the round, whatever `bet` says; otherwise a paid
   * spin of `bet` (one of BETS). A spin ends any double or nothing still
   * open: that win stays in the balance, where it already is.
   */
  async spin(actor: Actor, bet: number, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    // Free spins already won are still played if the Casino has closed since, like a blackjack hand or a Mines round in play.
    if (closed && !(await this.prisma.casinoBookFeature.findUnique({ where: { playerId: actor.id }, select: { playerId: true } }))) throw new ForbiddenException(closed);
    const team = await assertOnTeam(this.prisma, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      // One spin at a time per Player, and none while a bet or another game is going through.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      const feature = await tx.casinoBookFeature.findUnique({ where: { playerId: actor.id } });
      const free = feature !== null;
      // Closed with free spins that ended in the meantime: no paid spin.
      if (closed && !free) throw new ForbiddenException(closed);
      if (!free && (await tx.minesRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } }))) {
        throw new BadRequestException("Finish the Mines round you're playing first.");
      }
      if (!free && (await tx.penaltyRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } }))) {
        throw new BadRequestException("Finish the Penalty round you're playing first.");
      }
      if (!free && !BETS.some((allowed) => allowed === bet)) throw new BadRequestException(`Choose a bet of ${BETS.map((b) => money(b)).join(", ")}`);
      const playedAt = free ? feature.bet : new Prisma.Decimal(bet);
      const stake = free ? new Prisma.Decimal(0) : playedAt;
      if (!free) await this.limits.assertCanPlace(actor.id, Number(stake));

      const special = free ? (feature.special as Exclude<BookSymbol, "BOOK">) : null;
      const round: Spin = playSpin(special, this.draw);
      // Never past MAX_WIN times the bet, for this spin or the whole round of free spins with the spin that started it.
      const cap = playedAt.mul(MAX_WIN);
      const soFar = free ? feature.won : new Prisma.Decimal(0);
      const room = Prisma.Decimal.max(0, cap.sub(soFar));
      const win = Prisma.Decimal.min(inMoney(playedAt, round.win), room);
      const capped = win.add(soFar).greaterThanOrEqualTo(cap);
      const net = win.sub(stake);
      // A paid spin needs the stake in the balance; a free spin costs nothing, so it plays even on an empty balance.
      const moved = await tx.user.updateMany({ where: { id: actor.id, ...(free ? {} : { balance: { gte: stake } }) }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.");

      // Free spins: started by 3 books on a paid spin, 10 more for 3 books on a free one, over when they run out or the cap is reached.
      const freeSpinsWon = capped ? 0 : round.freeSpinsWon;
      let next: { bet: Prisma.Decimal; special: string; remaining: number; played: number; won: Prisma.Decimal } | null = null;
      let ended: Prisma.Decimal | null = null;
      if (free) {
        const remaining = capped ? 0 : feature.remaining - 1 + freeSpinsWon;
        const won = feature.won.add(win);
        if (remaining > 0) next = await tx.casinoBookFeature.update({ where: { playerId: actor.id }, data: { remaining, played: { increment: 1 }, won } });
        else {
          await tx.casinoBookFeature.delete({ where: { playerId: actor.id } });
          ended = won;
        }
      } else if (freeSpinsWon > 0) {
        next = await tx.casinoBookFeature.create({ data: { playerId: actor.id, bet: playedAt, special: drawSpecial(this.draw), remaining: freeSpinsWon, won: win } });
      }

      const now = new Date();
      const row = await tx.casinoSpin.create({
        data: {
          kind: "BOOK",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: playedAt,
          stake,
          win,
          free,
          freeSpinsWon,
          grid: round.grid,
          stops: round.stops,
          lines: { lines: round.lines, scatter: round.scatter, expansion: round.expansion, special } as unknown as Prisma.InputJsonValue,
          createdAt: now,
        },
        select: spinSelect,
      });
      // Counts in the team's results and commission like a settled bet (0 bets, the stake and the win).
      await tx.settlementEntry.create({
        data: { casinoSpinId: row.id, playerId: actor.id, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, bets: 0, stake, payout: win, createdAt: now },
      });
      await this.addToLedger(tx, actor.id, net, now);
      // Double or nothing: on a paid spin's win (unless it started free spins), or on the whole round once the free spins end.
      const toGamble = ended ?? (!free && !next ? win : null);
      // Double or nothing is a new bet, so it isn't offered once the Casino has closed.
      const gamble = toGamble && !closed && canGamble(toGamble, 0) ? await tx.casinoGamble.create({ data: { playerId: actor.id, amount: toGamble, game: "book" } }) : null;
      const balance = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } })).balance;
      return { row, round, win, net, free, next, ended, capped, gamble, balance };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    const roundTotal = result.ended ?? result.win;
    if (roundTotal.greaterThanOrEqualTo(result.row.bet.mul(100)) && (result.ended || !result.next)) {
      // Worth a line in the audit log: a spin or round of free spins paying 100 times the bet or more.
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.row.id, game: "book", bet: Number(result.row.bet), win: Number(roundTotal), capped: result.capped } });
    }
    const bet$ = result.row.bet;
    return {
      spin: spinView(result.row),
      grid: result.round.grid,
      lines: result.round.lines.map((line) => ({ ...line, win: Number(inMoney(bet$, line.win)) })),
      scatter: result.round.scatter ? { ...result.round.scatter, win: Number(inMoney(bet$, result.round.scatter.win)) } : null,
      expansion: result.round.expansion ? { ...result.round.expansion, perLine: Number(inMoney(bet$, result.round.expansion.perLine)), win: Number(inMoney(bet$, result.round.expansion.win)) } : null,
      /** What this spin paid (after the cap). */
      win: Number(result.win),
      free: result.free,
      /** Free spins this spin gave: 10 for starting or extending a round. */
      freeSpinsWon: result.row.freeSpinsWon,
      /** The round of free spins after this spin; null once there's none. */
      feature: featureView(result.next),
      /** The round's total, when this spin was its last. */
      featureEnded: result.ended ? Number(result.ended) : null,
      capped: result.capped,
      gamble: gambleView(result.gamble),
      balance: Number(result.balance),
    };
  }

  /** Adds a spin to the day's single "Book of Ra" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const since = startOfDay(now);
    const [paid, free] = await Promise.all([
      tx.casinoSpin.count({ where: { playerId, kind: "BOOK", free: false, createdAt: { gte: since } } }),
      tx.casinoSpin.count({ where: { playerId, kind: "BOOK", free: true, createdAt: { gte: since } } }),
    ]);
    const reason = [`${GAME_NAME}: ${paid === 1 ? "1 spin" : `${paid} spins`}`, ...(free ? [free === 1 ? "1 free spin" : `${free} free spins`] : [])].join(", ");
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
