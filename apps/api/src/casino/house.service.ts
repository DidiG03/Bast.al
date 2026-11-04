import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomInt } from "crypto";
import { CasinoPlayKind, Prisma, Role } from "@prisma/client";
import { Actor } from "../auth/permissions";
import { assertOnTeam } from "../bets/team";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { formatAll } from "../money";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { dayKey, startOfDay } from "../time";
import { UsersService } from "../users/users.service";
import { addToDailyLine, casinoClosedReason, maxStakeOf, type CasinoGame } from "./access";

type Tx = Prisma.TransactionClient;
type Team = { ownerId: string | null; managerId: string | null; ownerRate: Prisma.Decimal; managerRate: Prisma.Decimal };

/** The games played through here, with their round kind and how the day's ledger line counts them. */
export type HouseGame = Extract<CasinoGame, "wheel" | "baccarat" | "hilo" | "tower" | "crash">;
export const HOUSE_GAMES: readonly HouseGame[] = ["crash", "baccarat", "hilo", "wheel", "tower"];
export const HOUSE_KINDS: Record<HouseGame, CasinoPlayKind> = { wheel: "WHEEL", baccarat: "BACCARAT", hilo: "HILO", tower: "TOWER", crash: "CRASH" };
const LEDGER_NAMES: Record<HouseGame, { name: string; one: string; many: string }> = {
  wheel: { name: "Money Wheel", one: "spin", many: "spins" },
  baccarat: { name: "Baccarat", one: "hand", many: "hands" },
  hilo: { name: "Hi-Lo", one: "round", many: "rounds" },
  tower: { name: "Tower", one: "climb", many: "climbs" },
  crash: { name: "Crash", one: "round", many: "rounds" },
};
const NAMES: Record<HouseGame, string> = { wheel: "Money Wheel", baccarat: "Baccarat", hilo: "Hi-Lo", tower: "Tower", crash: "Crash" };

/** Each game has its own line per Player per day in their balance ledger. */
export const houseLedgerLineId = (game: HouseGame, playerId: string, at: Date) => `${game}_${playerId}_${dayKey(at)}`;
const dollars = (cents: number) => new Prisma.Decimal(cents).div(100);

/** A round in play this long untouched is settled (cashed out, refunded or played out, by the game). */
const IDLE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;

/** What a step of a round in play came to: still on (state), or over and paid `payoutCents`. */
export type StepResult<S> = { state: S; over: boolean; payoutCents: number };

/** How a game settles a round nobody finished: its last state, and what it pays (0 for a loss); `refund` puts the stake back unplayed. */
export type IdleSettle<S> = (state: S, now: number) => { state: S; payoutCents: number } | "refund";

/**
 * The money side of Money Wheel, Baccarat, Hi-Lo, Tower and Crash, the same
 * as every other Casino game: the stake leaves the balance in one
 * transaction with the round, the win comes back with it, each finished round
 * is a CasinoSpin with a settlement journal row for Commissions, and the day
 * has one ledger line per game. The Player's max stake, the daily loss limit
 * and the Casino's switches apply to every round. Hi-Lo, Tower and Crash keep
 * a round in play between requests (CasinoRound), one per Player.
 */
@Injectable()
export class HouseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HouseService.name);
  private timer: NodeJS.Timeout | null = null;
  /** Random draws: crypto.randomInt unless a test sets its own. */
  draw: (below: number) => number = randomInt;
  /** The server's clock, ms: Date.now unless a test sets its own. */
  now: () => number = Date.now;
  /** How each game with rounds in play settles one nobody finished. */
  private readonly idle = new Map<HouseGame, IdleSettle<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
  ) {}

  onModuleInit() {
    if (process.env.HOUSE_SWEEP_DISABLED === "true") return;
    this.timer = setInterval(() => void this.settleIdle().catch((error) => this.logger.error(error)), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Registers how a game with rounds in play settles an abandoned one. */
  onIdle<S>(game: HouseGame, settle: IdleSettle<S>) {
    this.idle.set(game, settle as IdleSettle<unknown>);
  }

  assertPlayer(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
  }

  /** The most one round can stake: the Player's max stake, or the top chip. */
  async tableMax(playerId: string, bets: readonly number[]): Promise<number> {
    const max = await maxStakeOf(this.prisma, playerId);
    const top = bets[bets.length - 1];
    return max === null ? top : Math.min(max, top);
  }

  /** What every game's page needs: whether it's open, the balance, the table max, and the last rounds. */
  async basics(actor: Actor, game: HouseGame, bets: readonly number[], recent = 20) {
    this.assertPlayer(actor);
    const [closed, player, tableMax, rows] = await Promise.all([
      casinoClosedReason(this.prisma, actor, game),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.tableMax(actor.id, bets),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id, kind: HOUSE_KINDS[game] }, orderBy: { createdAt: "desc" }, take: recent, select: { id: true, bet: true, win: true, house: true, createdAt: true } }),
    ]);
    return {
      closed,
      balance: Number(player.balance),
      tableMax,
      recent: rows.map((row) => ({ id: row.id, bet: Number(row.bet), win: Number(row.win), round: row.house, createdAt: row.createdAt })),
    };
  }

  /** The round in play for this game, if any. */
  async openRound(playerId: string, game: HouseGame) {
    const row = await this.prisma.casinoRound.findUnique({ where: { playerId } });
    return row && row.game === game ? row : null;
  }

  /** Checks a stake: one of the chips, within the Player's max stake. Returns it in cents. */
  private async stakeCents(actor: Actor, game: HouseGame, bet: number, bets: readonly number[]): Promise<number> {
    const closed = await casinoClosedReason(this.prisma, actor, game);
    if (closed) throw new ForbiddenException(closed);
    const cents = Math.round(bet * 100);
    if (!Number.isFinite(bet) || Math.abs(cents - bet * 100) > 1e-6 || !bets.includes(bet)) {
      throw new BadRequestException(`A round of ${NAMES[game]} costs ${bets.map((value) => value.toFixed(2)).join(", ")} ALL`);
    }
    const tableMax = await this.tableMax(actor.id, bets);
    if (bet > tableMax) throw new BadRequestException(`The most you can bet on one round is ${formatAll(tableMax)}`);
    return cents;
  }

  /** Locks the Player for one transaction: one game, bet or round at a time. */
  private async lock(tx: Tx, playerId: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${playerId} FOR UPDATE`;
  }

  /** A round that's over in one go (Money Wheel, Baccarat): the stake, `play` (what it pays, in cents, and the record), the pay-out. */
  async instant<R extends object>(actor: Actor, game: HouseGame, bet: number, bets: readonly number[], play: (stakeCents: number, draw: (below: number) => number) => { payoutCents: number; record: R }) {
    this.assertPlayer(actor);
    const stakeCents = await this.stakeCents(actor, game, bet, bets);
    const team = await assertOnTeam(this.prisma, actor);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.id);
      // A slot win still open to double or nothing is taken as it is: it's already in the balance.
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet, 0, tx);
      const { payoutCents, record } = play(stakeCents, this.draw);
      const net = dollars(payoutCents - stakeCents);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: dollars(stakeCents) } }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.");
      const now = new Date(this.now());
      const spin = await this.record(tx, actor.id, team, game, stakeCents, payoutCents, { game, ...record }, now);
      await this.addToLedger(tx, game, actor.id, payoutCents - stakeCents, now, false);
      return { spin, net, balance: await this.balanceIn(tx, actor.id) };
    });
    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    return { id: result.spin.id, balance: result.balance };
  }

  /** Starts a round that's played over several requests: the stake leaves now, `make` sets the round up. */
  async start<S>(actor: Actor, game: HouseGame, bet: number, bets: readonly number[], make: (stakeCents: number, draw: (below: number) => number, now: number) => S) {
    this.assertPlayer(actor);
    const stakeCents = await this.stakeCents(actor, game, bet, bets);
    const team = await assertOnTeam(this.prisma, actor);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.id);
      const open = await tx.casinoRound.findUnique({ where: { playerId: actor.id }, select: { game: true } });
      if (open) throw new BadRequestException(open.game === game ? `Finish the ${NAMES[game]} round you're playing first.` : `Finish your ${NAMES[open.game as HouseGame] ?? "Casino"} round first.`);
      if (await tx.minesRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) throw new BadRequestException("Finish the Mines round you're playing first.");
      if (await tx.penaltyRound.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) throw new BadRequestException("Finish the Penalty round you're playing first.");
      if (await tx.blackjackHand.findUnique({ where: { playerId: actor.id }, select: { playerId: true } })) throw new BadRequestException("Finish the hand you're playing first.");
      await tx.casinoGamble.deleteMany({ where: { playerId: actor.id } });
      await this.limits.assertCanPlace(actor.id, bet, 0, tx);
      const amount = dollars(stakeCents);
      const moved = await tx.user.updateMany({ where: { id: actor.id, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.");
      const state = make(stakeCents, this.draw, this.now());
      const now = new Date(this.now());
      await this.addToLedger(tx, game, actor.id, -stakeCents, now, true);
      await tx.casinoRound.create({
        data: { playerId: actor.id, game, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, staked: amount, state: state as unknown as Prisma.InputJsonValue },
      });
      return { state, balance: await this.balanceIn(tx, actor.id) };
    });
    await this.realtime.publishBalances([actor.id]);
    await this.users.alertLowBalance(actor.id, stakeCents / 100);
    return result;
  }

  /**
   * One step of the round in play: `apply` gets its state and the server's
   * clock and says where it stands. A finished round is paid and recorded.
   * `errors` turns a game's own error into a 400 with its message.
   */
  async step<S>(actor: Actor, game: HouseGame, apply: (state: S, draw: (below: number) => number, now: number) => StepResult<S>, errors: new (...args: never[]) => Error, noRound = `There's no ${NAMES[game]} round in play. Start one first.`) {
    this.assertPlayer(actor);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, actor.id);
      const row = await tx.casinoRound.findUnique({ where: { playerId: actor.id } });
      if (!row || row.game !== game) throw new BadRequestException(noRound);
      let outcome: StepResult<S>;
      try {
        outcome = apply(row.state as unknown as S, this.draw, this.now());
      } catch (error) {
        if (error instanceof errors) throw new BadRequestException(error.message);
        throw error;
      }
      if (!outcome.over) {
        await tx.casinoRound.update({ where: { playerId: actor.id }, data: { state: outcome.state as unknown as Prisma.InputJsonValue } });
      } else {
        await tx.casinoRound.delete({ where: { playerId: actor.id } });
        await this.finish(tx, actor.id, row, game, outcome.state, outcome.payoutCents, new Date(this.now()));
      }
      return { state: outcome.state, over: outcome.over, payoutCents: outcome.payoutCents, balance: await this.balanceIn(tx, actor.id) };
    });
    if (result.over) await this.realtime.publishBalances([actor.id]);
    return result;
  }

  /** Settles every round nobody has touched for a while, so no money stays riding. */
  async settleIdle(now = this.now()) {
    const idle = await this.prisma.casinoRound.findMany({ where: { updatedAt: { lt: new Date(now - IDLE_MS) } }, select: { playerId: true } });
    for (const { playerId } of idle) {
      await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, playerId);
        const row = await tx.casinoRound.findUnique({ where: { playerId } });
        if (!row || row.updatedAt.getTime() >= now - IDLE_MS) return;
        const settle = this.idle.get(row.game as HouseGame);
        if (!settle) return;
        const outcome = settle(row.state, now);
        await tx.casinoRound.delete({ where: { playerId } });
        if (outcome === "refund") await this.refund(tx, row.game as HouseGame, playerId, Math.round(Number(row.staked) * 100), new Date(now));
        else await this.finish(tx, playerId, row, row.game as HouseGame, outcome.state, outcome.payoutCents, new Date(now));
      });
      await this.realtime.publishBalances([playerId]);
    }
    return idle.length;
  }

  /** Pays a finished round in play and records it. */
  private async finish(tx: Tx, playerId: string, row: Team & { staked: Prisma.Decimal }, game: HouseGame, state: unknown, payoutCents: number, now: Date) {
    const stakeCents = Math.round(Number(row.staked) * 100);
    if (payoutCents > 0) await tx.user.update({ where: { id: playerId }, data: { balance: { increment: dollars(payoutCents) } } });
    await this.record(tx, playerId, row, game, stakeCents, payoutCents, { game, ...(state as object) }, now);
    await this.addToLedger(tx, game, playerId, payoutCents, now, false);
  }

  /** A finished round: the casino round, and the journal row that counts it in the team's results and commission. */
  private async record(tx: Tx, playerId: string, team: Team, game: HouseGame, stakeCents: number, payoutCents: number, house: object, now: Date) {
    const stake = dollars(stakeCents);
    const win = dollars(payoutCents);
    const spin = await tx.casinoSpin.create({
      data: {
        kind: HOUSE_KINDS[game],
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
        house: house as Prisma.InputJsonValue,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.settlementEntry.create({
      data: { casinoSpinId: spin.id, playerId, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, bets: 0, stake, payout: win, createdAt: now },
    });
    return spin;
  }

  /** Puts an unplayed round's stake back, and drops the day's line when nothing else was played. */
  private async refund(tx: Tx, game: HouseGame, playerId: string, cents: number, now: Date) {
    await tx.user.update({ where: { id: playerId }, data: { balance: { increment: dollars(cents) } } });
    const lineId = houseLedgerLineId(game, playerId, now);
    const line = await tx.balanceTransaction.findUnique({ where: { id: lineId }, select: { amount: true } });
    const played = await tx.casinoSpin.count({ where: { playerId, kind: HOUSE_KINDS[game], createdAt: { gte: startOfDay(now) } } });
    if (line && line.amount.add(dollars(cents)).isZero() && played === 0) await tx.balanceTransaction.delete({ where: { id: lineId } });
    else await this.addToLedger(tx, game, playerId, cents, now, false);
  }

  /** Adds money moved (cents, signed) to the day's single line for this game in the Player's ledger. */
  private async addToLedger(tx: Tx, game: HouseGame, playerId: string, cents: number, now: Date, inPlay: boolean) {
    const played = await tx.casinoSpin.count({ where: { playerId, kind: HOUSE_KINDS[game], createdAt: { gte: startOfDay(now) } } });
    const rounds = played + (inPlay ? 1 : 0);
    const names = LEDGER_NAMES[game];
    const reason = rounds === 1 ? `${names.name}: 1 ${names.one}` : `${names.name}: ${rounds} ${names.many}`;
    await addToDailyLine(tx, houseLedgerLineId(game, playerId, now), playerId, dollars(cents), reason, now);
  }

  private async balanceIn(tx: Tx, playerId: string) {
    return Number((await tx.user.findUniqueOrThrow({ where: { id: playerId }, select: { balance: true } })).balance);
  }
}
