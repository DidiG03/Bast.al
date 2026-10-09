import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
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
import { activeSeed, lockedActiveSeed, previousSeed, revealedSeeds, seedView } from "./fair-seeds";
import { BETS, CELLS, GAME_NAME, MAX_MULTIPLIER, PRIZES, SYMBOLS, cardFor, payoutRate, winCents, winChance, type ScratchSymbol } from "./scratch";

/** Cards in the Player's recent list. */
const RECENT = 20;
/** A card paying this many times its price or more goes in the audit log. */
const BIG_WIN = 100;

/** Scratch Cards have their own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `scratch_${playerId}_${dayKey(at)}`;

const roundSelect = { id: true, bet: true, win: true, scratch: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { cells: ScratchSymbol[]; symbol: ScratchSymbol | null; multiplier: number; seedId: string; serverSeedHash: string; clientSeed: string; nonce: number };

function roundView(round: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>, revealed: Map<string, string>) {
  const stored = round.scratch as Stored;
  return {
    id: round.id,
    /** The 9 boxes, left to right and top to bottom. */
    cells: stored.cells,
    /** The symbol that shows three times, or null for a card that doesn't win. */
    symbol: stored.symbol,
    multiplier: stored.multiplier,
    bet: Number(round.bet),
    win: Number(round.win),
    serverSeedHash: stored.serverSeedHash,
    clientSeed: stored.clientSeed,
    nonce: stored.nonce,
    /** The server seed, once the Player has changed seeds; until then, null. */
    serverSeed: revealed.get(stored.seedId) ?? null,
    createdAt: round.createdAt,
  };
}

/**
 * Scratch Cards (see scratch.ts), played with the Player's Bast.al balance
 * like the other games: the card comes from the Player's seed pair (shared
 * with Dice, Keno and Coin Flip) here on the server, and is paid when it's
 * bought, in one transaction (the balance, a settlement journal row for
 * Commissions, and the day's ledger line). Scratching it in the browser only
 * shows what it holds. The Player's max stake, the daily loss limit and the
 * Casino's switches apply to every card.
 */
@Injectable()
export class ScratchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The most one card can cost this Player: their max stake, or the top price without one. */
  private async tableMax(playerId: string): Promise<number> {
    const max = await maxStakeOf(this.prisma, playerId);
    const top = BETS[BETS.length - 1];
    return max === null ? top : Math.min(max, top);
  }

  /** The Player's scratch cards: whether they can play, the prizes, their seed pair and their last cards. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, recent, seed, previous] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "SCRATCH" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
      lockedActiveSeed(this.prisma, actor.id),
      previousSeed(this.prisma, actor.id),
    ]);
    const revealed = await revealedSeeds(this.prisma, recent.map((round) => (round.scratch as Stored | null)?.seedId));
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      recent: recent.map((round) => roundView(round, revealed)),
      seed: seedView(seed),
      /** The last seed pair the Player changed, its server seed shown. */
      previousSeed: previous ? seedView(previous) : null,
      game: {
        name: GAME_NAME,
        cells: CELLS,
        symbols: SYMBOLS,
        bets: BETS,
        /** The prizes, smallest first, with their chance in percent. */
        prizes: PRIZES.map((prize) => ({ symbol: prize.symbol, multiplier: prize.multiplier, chance: (prize.odds / 1_000_000) * 100 })),
        maxMultiplier: MAX_MULTIPLIER,
        payoutRate: Math.round(payoutRate() * 10) / 10,
        winChance: Math.round(winChance() * 10) / 10,
      },
    };
  }

  /** Buys one card: the price, the card from the Player's seed pair, and its prize, paid at once. */
  async buy(actor: Actor, betInput: number, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const bet = Number(betInput);
    if (!(BETS as readonly number[]).includes(bet)) throw new BadRequestException(`A card costs ${BETS.map((value) => value.toFixed(2)).join(", ")} ALL`);
    const tableMax = await this.tableMax(actor.id);
    if (bet > tableMax) throw new BadRequestException(`The most a card can cost you is ${tableMax.toFixed(2)} ALL`);
    const team = await assertOnTeam(this.prisma, actor);
    const stakeCents = Math.round(bet * 100);

    const result = await this.prisma.$transaction(async (tx) => {
      // One card at a time per Player, and none while another game or a bet is going through. This also keeps the nonce in order.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet);

      const seed = await activeSeed(tx, actor.id);
      const card = cardFor(seed.serverSeed, seed.clientSeed, seed.nonce);
      const stake = new Prisma.Decimal(stakeCents).div(100);
      const win = new Prisma.Decimal(winCents(stakeCents, card.multiplier)).div(100);
      const net = win.sub(stake);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: stake } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this card. Lower the price, or ask your Manager for a top-up.");
      const nextSeed = await tx.diceSeed.update({ where: { id: seed.id }, data: { nonce: { increment: 1 } } });

      const now = new Date();
      const round = await tx.casinoSpin.create({
        data: {
          kind: "SCRATCH",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: stake,
          stake,
          win,
          grid: card.cells,
          stops: [],
          lines: {},
          scratch: { ...card, seedId: seed.id, serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce: seed.nonce } satisfies Stored,
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
      return { round, card, net, balance, seed: nextSeed };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    if (result.card.multiplier >= BIG_WIN) {
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.round.id, game: "scratch", symbol: result.card.symbol, multiplier: result.card.multiplier, win: Number(result.round.win) } });
    }
    return { round: roundView(result.round, new Map()), balance: Number(result.balance), seed: seedView(result.seed) };
  }

  /** Adds a card to the day's single "Scratch Cards" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const cards = await tx.casinoSpin.count({ where: { playerId, kind: "SCRATCH", createdAt: { gte: startOfDay(now) } } });
    const reason = cards === 1 ? "Scratch Cards: 1 card" : `Scratch Cards: ${cards} cards`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
