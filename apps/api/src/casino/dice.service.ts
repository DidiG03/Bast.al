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
import {
  BETS,
  DIRECTIONS,
  GAME_NAME,
  MAX_BET,
  MAX_WINNING,
  MIN_BET,
  MIN_WINNING,
  OUTCOMES,
  PAYOUT_RATE,
  hashSeed,
  invalidTarget,
  isClientSeed,
  label,
  multiplierOf,
  newClientSeed,
  newServerSeed,
  rollFor,
  targetUnits,
  winCents,
  winningNumbers,
  wins,
  type Direction,
} from "./dice";

/** Rolls in the Player's recent list. */
const RECENT = 20;
/** A roll paying this many times its stake or more goes in the audit log. */
const BIG_WIN = 50;

/** Dice has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `dice_${playerId}_${dayKey(at)}`;

const roundSelect = { id: true, bet: true, win: true, dice: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { target: number; direction: Direction; roll: number; winning: number; multiplier: number; seedId: string; serverSeedHash: string; clientSeed: string; nonce: number };

function roundView(round: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>, revealed: Map<string, string>) {
  const stored = round.dice as Stored;
  return {
    id: round.id,
    target: stored.target / 100,
    direction: stored.direction,
    roll: stored.roll / 100,
    chance: stored.winning / 100,
    multiplier: stored.multiplier,
    won: Number(round.win) > 0,
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
 * Dice (see dice.ts), played with the Player's Bast.al balance like the
 * other games: the roll comes from the Player's seed pair here on the
 * server, and moves money in one transaction (the balance, a settlement
 * journal row for Commissions, and the day's ledger line). The Player's max
 * stake, the daily loss limit and the Casino's switches apply to every roll.
 */
@Injectable()
export class DiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The most one roll can cost this Player: their max stake, or MAX_BET without one. */
  private async tableMax(playerId: string): Promise<number> {
    const max = await maxStakeOf(this.prisma, playerId);
    return max === null ? MAX_BET : Math.min(max, MAX_BET);
  }

  /** The Player's dice table: whether they can play, the rules, their seed pair and their last rolls. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, recent, seed, previous] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "DICE" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
      lockedActiveSeed(this.prisma, actor.id),
      previousSeed(this.prisma, actor.id),
    ]);
    const revealed = await revealedSeeds(this.prisma, recent.map((round) => (round.dice as Stored | null)?.seedId));
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
        outcomes: OUTCOMES,
        payoutRate: PAYOUT_RATE,
        minChance: MIN_WINNING / 100,
        maxChance: MAX_WINNING / 100,
        minBet: MIN_BET,
        maxBet: MAX_BET,
        bets: BETS,
        maxMultiplier: multiplierOf(MIN_WINNING),
      },
    };
  }

  /** One roll: the stake, the roll from the Player's seed pair, and the pay-out. */
  async roll(actor: Actor, betInput: number, targetInput: number, directionInput: string, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    if (!(BETS as readonly number[]).includes(Number(betInput))) throw new BadRequestException(`A roll costs ${BETS.map((value) => value.toFixed(2)).join(", ")} ALL`);
    const stakeCents = Math.round(Number(betInput) * 100);
    if (!(DIRECTIONS as readonly string[]).includes(directionInput)) throw new BadRequestException("Roll over or under the target.");
    const direction = directionInput as Direction;
    const target = targetUnits(Number(targetInput));
    if (target === null) throw new BadRequestException("The target is a number from 0.00 to 99.99.");
    const invalid = invalidTarget(target, direction);
    if (invalid) throw new BadRequestException(invalid);
    const tableMax = await this.tableMax(actor.id);
    if (stakeCents > Math.round(tableMax * 100)) throw new BadRequestException(`The most a roll can cost you is ${tableMax.toFixed(2)} ALL`);
    const team = await assertOnTeam(this.prisma, actor);
    const winning = winningNumbers(target, direction);

    const result = await this.prisma.$transaction(async (tx) => {
      // One roll at a time per Player, and none while a slot spin or a bet is going through. This also keeps the nonce in order.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, stakeCents / 100, 0, tx);

      const seed = await activeSeed(tx, actor.id);
      const roll = rollFor(seed.serverSeed, seed.clientSeed, seed.nonce);
      const won = wins(roll, target, direction);
      const stake = new Prisma.Decimal(stakeCents).div(100);
      const win = new Prisma.Decimal(won ? winCents(stakeCents, winning) : 0).div(100);
      const net = win.sub(stake);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: stake } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this roll. Lower the stake, or ask your Manager for a top-up.");
      const nextSeed = await tx.diceSeed.update({ where: { id: seed.id }, data: { nonce: { increment: 1 } } });

      const now = new Date();
      const round = await tx.casinoSpin.create({
        data: {
          kind: "DICE",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: stake,
          stake,
          win,
          grid: [],
          stops: [roll],
          lines: {},
          dice: { target, direction, roll, winning, multiplier: multiplierOf(winning), seedId: seed.id, serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce: seed.nonce } satisfies Stored,
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
      return { round, roll, won, net, balance, seed: nextSeed };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    if (result.won && multiplierOf(winning) >= BIG_WIN) {
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.round.id, game: "dice", roll: label(result.roll), multiplier: multiplierOf(winning), win: Number(result.round.win) } });
    }
    return { round: roundView(result.round, new Map()), balance: Number(result.balance), seed: seedView(result.seed) };
  }

  /**
   * Changes the Player's seed pair: the active server seed is shown from now
   * on, so every roll made with it can be checked, and a new one (hash
   * shown, seed kept secret) takes over with the client seed they choose,
   * or a new random one.
   */
  async changeSeed(actor: Actor, clientSeedInput?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    if (clientSeedInput !== undefined && !isClientSeed(clientSeedInput)) throw new BadRequestException("A client seed is 1 to 32 letters, digits, dashes or underscores.");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      const current = await activeSeed(tx, actor.id);
      const previous = await tx.diceSeed.update({ where: { id: current.id }, data: { active: false, revealedAt: new Date() } });
      const serverSeed = newServerSeed();
      const seed = await tx.diceSeed.create({ data: { playerId: actor.id, serverSeed, serverSeedHash: hashSeed(serverSeed), clientSeed: clientSeedInput ?? newClientSeed() } });
      return { seed: seedView(seed), previousSeed: seedView(previous) };
    });
  }

  /** Adds a roll to the day's single "Dice" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const rolls = await tx.casinoSpin.count({ where: { playerId, kind: "DICE", createdAt: { gte: startOfDay(now) } } });
    const reason = rolls === 1 ? "Dice: 1 roll" : `Dice: ${rolls} rolls`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
