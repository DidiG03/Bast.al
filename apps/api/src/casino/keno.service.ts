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
import { BETS, DRAWN, GAME_NAME, MAX_MULTIPLIER, MAX_PICKS, MIN_PICKS, NUMBERS, PAYS, drawFor, hitsOf, invalidPicks, payoutRate, winCents } from "./keno";

/** Rounds in the Player's recent list. */
const RECENT = 20;
/** A round paying this many times its stake or more goes in the audit log. */
const BIG_WIN = 100;

/** Keno has its own line per Player per day in their balance ledger. */
const ledgerLineId = (playerId: string, at: Date) => `keno_${playerId}_${dayKey(at)}`;

const roundSelect = { id: true, bet: true, win: true, keno: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

type Stored = { picks: number[]; drawn: number[]; hits: number[]; multiplier: number; seedId: string; serverSeedHash: string; clientSeed: string; nonce: number };

function roundView(round: Prisma.CasinoSpinGetPayload<{ select: typeof roundSelect }>, revealed: Map<string, string>) {
  const stored = round.keno as Stored;
  return {
    id: round.id,
    picks: stored.picks,
    /** In the order they were drawn. */
    drawn: stored.drawn,
    hits: stored.hits,
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
 * Keno (see keno.ts), played with the Player's Bast.al balance like the
 * other games: the draw comes from the Player's seed pair (shared with
 * Dice) here on the server, and moves money in one transaction (the
 * balance, a settlement journal row for Commissions, and the day's ledger
 * line). The Player's max stake, the daily loss limit and the Casino's
 * switches apply to every round.
 */
@Injectable()
export class KenoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** The most one round can cost this Player: their max stake, or the top bet without one. */
  private async tableMax(playerId: string): Promise<number> {
    const max = await maxStakeOf(this.prisma, playerId);
    const top = BETS[BETS.length - 1];
    return max === null ? top : Math.min(max, top);
  }

  /** The Player's Keno board: whether they can play, the rules and pay table, their seed pair and their last rounds. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, tableMax, recent, seed, previous] = await Promise.all([
      casinoClosedReason(this.prisma, actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: "KENO" }, orderBy: { createdAt: "desc" }, take: RECENT, select: roundSelect }),
      lockedActiveSeed(this.prisma, actor.id),
      previousSeed(this.prisma, actor.id),
    ]);
    const revealed = await revealedSeeds(this.prisma, recent.map((round) => (round.keno as Stored | null)?.seedId));
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
        numbers: NUMBERS,
        drawn: DRAWN,
        minPicks: MIN_PICKS,
        maxPicks: MAX_PICKS,
        bets: BETS,
        pays: PAYS,
        maxMultiplier: MAX_MULTIPLIER,
        /** Per number of picks, rounded to a tenth. */
        payoutRates: Object.fromEntries(Object.keys(PAYS).map((picks) => [picks, Math.round(payoutRate(Number(picks)) * 10) / 10])),
      },
    };
  }

  /** One round: the stake, the draw from the Player's seed pair, and the pay-out. */
  async play(actor: Actor, betInput: number, picksInput: number[], ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await casinoClosedReason(this.prisma, actor);
    if (closed) throw new ForbiddenException(closed);
    const bet = Number(betInput);
    if (!(BETS as readonly number[]).includes(bet)) throw new BadRequestException(`A round costs ${BETS.map((value) => value.toFixed(2)).join(", ")} ALL`);
    const invalid = invalidPicks(picksInput);
    if (invalid) throw new BadRequestException(invalid);
    const picks = [...picksInput].sort((a, b) => a - b);
    const tableMax = await this.tableMax(actor.id);
    if (bet > tableMax) throw new BadRequestException(`The most a round can cost you is ${tableMax.toFixed(2)} ALL`);
    const team = await assertOnTeam(this.prisma, actor);
    const stakeCents = Math.round(bet * 100);

    const result = await this.prisma.$transaction(async (tx) => {
      // One round at a time per Player, and none while another game or a bet is going through. This also keeps the nonce in order.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet);

      const seed = await activeSeed(tx, actor.id);
      const drawn = drawFor(seed.serverSeed, seed.clientSeed, seed.nonce);
      const hits = hitsOf(picks, drawn);
      const multiplier = PAYS[picks.length][hits.length];
      const stake = new Prisma.Decimal(stakeCents).div(100);
      const win = new Prisma.Decimal(winCents(stakeCents, picks.length, hits.length)).div(100);
      const net = win.sub(stake);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: stake } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this round. Lower the stake, or ask your Manager for a top-up.");
      const nextSeed = await tx.diceSeed.update({ where: { id: seed.id }, data: { nonce: { increment: 1 } } });

      const now = new Date();
      const round = await tx.casinoSpin.create({
        data: {
          kind: "KENO",
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: stake,
          stake,
          win,
          grid: [],
          stops: drawn,
          lines: {},
          keno: { picks, drawn, hits, multiplier, seedId: seed.id, serverSeedHash: seed.serverSeedHash, clientSeed: seed.clientSeed, nonce: seed.nonce } satisfies Stored,
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
      return { round, hits, multiplier, net, balance, seed: nextSeed };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    if (result.multiplier >= BIG_WIN) {
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.round.id, game: "keno", picks: picks.length, hits: result.hits.length, multiplier: result.multiplier, win: Number(result.round.win) } });
    }
    return { round: roundView(result.round, new Map()), balance: Number(result.balance), seed: seedView(result.seed) };
  }

  /** Adds a round to the day's single "Keno" line in the Player's ledger. */
  private async addToLedger(tx: Prisma.TransactionClient, playerId: string, net: Prisma.Decimal, now: Date) {
    const rounds = await tx.casinoSpin.count({ where: { playerId, kind: "KENO", createdAt: { gte: startOfDay(now) } } });
    const reason = rounds === 1 ? "Keno: 1 round" : `Keno: ${rounds} rounds`;
    await addToDailyLine(tx, ledgerLineId(playerId, now), playerId, net, reason, now);
  }
}
