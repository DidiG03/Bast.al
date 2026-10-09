import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { assertOnTeam } from "../bets/team";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { dayKey, startOfDay } from "../time";
import { UsersService } from "../users/users.service";
import { addToDailyLine, casinoClosedReason, maxStakeOf } from "./access";
import { BETS, GAME_NAME, MULTIPLIER, PAYOUT_RATE, SIDES, flipFor, winCents, type Side } from "./coin-flip";
import { activeSeed, lockedActiveSeed, previousSeed, revealedSeeds, seedView } from "./fair-seeds";

/** Flips in the Player's recent list. */
const RECENT = 20;

/** Coin Flip has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `coinflip_${playerId}_${dayKey(at)}`;

const roundSelect = { id: true, bet: true, win: true, coin: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { call: Side; side: Side; multiplier: number; seedId: string; serverSeedHash: string; clientSeed: string; nonce: number };

function roundView(round: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>, revealed: Map<string, string>) {
  const stored = round.coin as Stored;
  return {
    id: round.id,
    /** The side the Player called. */
    call: stored.call,
    /** The side that came up. */
    side: stored.side,
    won: stored.call === stored.side,
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
 * Coin Flip (see coin-flip.ts), played with the Player's Bast.al balance
 * like the other games: the flip comes from the Player's seed pair (shared
 * with Dice and Keno) here on the server, and moves money in one
 * transaction (the balance, a settlement journal row for Commissions, and
 * the day's ledger line). The Player's max stake, the daily loss limit and
 * the Casino's switches apply to every flip.
 */
@Injectable()
export class CoinFlipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
  ) {}

  /** The most one flip can cost this Player: their max stake, or the top bet without one. */
  private async tableMax(playerId: string): Promise<number> {
    const max = await maxStakeOf(this.prisma, playerId);
    const top = BETS[BETS.length - 1];
    return max === null ? top : Math.min(max, top);
  }

  /** The Player's coin: whether they can play, the rules, their seed pair and their last flips. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, recent, seed, previous] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "COIN_FLIP" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
      lockedActiveSeed(this.prisma, actor.id),
      previousSeed(this.prisma, actor.id),
    ]);
    const revealed = await revealedSeeds(this.prisma, recent.map((round) => (round.coin as Stored | null)?.seedId));
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      recent: recent.map((round) => roundView(round, revealed)),
      seed: seedView(seed),
      /** The last seed pair the Player changed, its server seed shown. */
      previousSeed: previous ? seedView(previous) : null,
      game: { name: GAME_NAME, sides: SIDES, bets: BETS, multiplier: MULTIPLIER, payoutRate: PAYOUT_RATE },
    };
  }

  /** One flip: the stake, the flip from the Player's seed pair, and the pay-out. */
  async flip(actor: Actor, betInput: number, callInput: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const bet = Number(betInput);
    if (!(BETS as readonly number[]).includes(bet)) throw new BadRequestException(`A flip costs ${BETS.map((value) => value.toFixed(2)).join(", ")} ALL`);
    if (!(SIDES as readonly string[]).includes(callInput)) throw new BadRequestException("Call heads or tails.");
    const call = callInput as Side;
    const tableMax = await this.tableMax(actor.id);
    if (bet > tableMax) throw new BadRequestException(`The most a flip can cost you is ${tableMax.toFixed(2)} ALL`);
    const team = await assertOnTeam(this.prisma, actor);
    const stakeCents = Math.round(bet * 100);

    const result = await this.prisma.$transaction(async (tx) => {
      // One flip at a time per Player, and none while another game or a bet is going through. This also keeps the nonce in order.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet);

      const seed = await activeSeed(tx, actor.id);
      const side = flipFor(seed.serverSeed, seed.clientSeed, seed.nonce);
      const won = side === call;
      const stake = new Prisma.Decimal(stakeCents).div(100);
      const win = new Prisma.Decimal(won ? winCents(stakeCents) : 0).div(100);
      const net = win.sub(stake);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: stake } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this flip. Lower the stake, or ask your Manager for a top-up.");
      const nextSeed = await tx.diceSeed.update({ where: { id: seed.id }, data: { nonce: { increment: 1 } } });

      const now = new Date();
      const round = await tx.casinoSpin.create({
        data: {
          kind: "COIN_FLIP",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: stake,
          stake,
          win,
          grid: [],
          stops: [side],
          lines: {},
          coin: { call, side, multiplier: MULTIPLIER, seedId: seed.id, serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce: seed.nonce } satisfies Stored,
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
      return { round, net, balance, seed: nextSeed };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    return { round: roundView(result.round, new Map()), balance: Number(result.balance), seed: seedView(result.seed) };
  }

  /** Adds a flip to the day's single "Coin Flip" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const flips = await tx.casinoSpin.count({ where: { playerId, kind: "COIN_FLIP", createdAt: { gte: startOfDay(now) } } });
    const reason = flips === 1 ? "Coin Flip: 1 flip" : `Coin Flip: ${flips} flips`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
