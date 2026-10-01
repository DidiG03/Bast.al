import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { BalanceTransactionType, Prisma, Role } from "@prisma/client";
import type { RandomNumberGenerating } from "pokie";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { assertOnTeam } from "../bets/team";
import { BettingLimitsService } from "../commissions/betting-limits.service";
import { CommissionsService } from "../commissions/commissions.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { dayKey, startOfDay } from "../time";
import { UsersService } from "../users/users.service";
import { casinoClosedReason } from "./access";
import { BETS, FREE_SPINS, LINES, LINE_PAYS, LINE_SHAPES, PAYOUT_RATE, REELS, ROWS, SCATTER, SCATTER_PAYS, SYMBOLS, WILD, playRound, type Round } from "./game";

const RECENT = 10;

const money = (value: Prisma.Decimal | number) => `$${Number(value).toFixed(2)}`;

/** Line bets (a tenth of the bet) in dollars. */
const inMoney = (bet: Prisma.Decimal, lineBets: number) => Number(bet.div(LINES).mul(lineBets).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN));

/** One line per Player per day in their balance ledger, updated with every spin. */
const ledgerLineId = (playerId: string, at: Date) => `casino_${playerId}_${dayKey(at)}`;

/** A spin as a Player sees it in their recent list. */
const spinSelect = { id: true, bet: true, stake: true, win: true, free: true, freeSpinsWon: true, createdAt: true } satisfies Prisma.CasinoSpinSelect;

function spinView(spin: Prisma.CasinoSpinGetPayload<{ select: typeof spinSelect }>) {
  return { id: spin.id, bet: Number(spin.bet), stake: Number(spin.stake), win: Number(spin.win), free: spin.free, freeSpinsWon: spin.freeSpinsWon, createdAt: spin.createdAt };
}

/**
 * The Casino tab: one slot game (see game.ts), played with the Player's own
 * Bast.al balance. Each spin is decided here, never in the browser, and
 * moves money like a bet does:
 * - the stake and the win change the balance in one guarded update;
 * - the day's "Casino" line in the Player's ledger is updated with it;
 * - a settlement journal row carries the team and rates, so casino profit
 *   counts in Commissions like sports profit;
 * - the daily loss limit counts sports and casino together.
 * Super Admin opens the Casino for the site, and each Owner for their team.
 */
@Injectable()
export class CasinoService {
  /** Where the reels stop: crypto.randomInt unless a test sets its own. */
  rng: RandomNumberGenerating | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: BettingLimitsService,
    private readonly commissions: CommissionsService,
    private readonly realtime: RealtimeService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /** Why this Player can't play right now, or null if they can. */
  closedReason(player: Pick<Actor, "id" | "parentId">): Promise<string | null> {
    return casinoClosedReason(this.prisma, player);
  }

  /** The Player's Casino: whether they can play, the game's rules, their free spins and recent spins. */
  async state(actor: Actor) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const [closed, player, freeSpins, recent, limit] = await Promise.all([
      this.closedReason(actor),
      this.prisma.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } }),
      this.prisma.casinoFreeSpins.findUnique({ where: { playerId: actor.id } }),
      this.prisma.casinoSpin.findMany({ where: { playerId: actor.id }, orderBy: { createdAt: "desc" }, take: RECENT, select: { ...spinSelect, grid: true } }),
      this.prisma.bettingLimit.findUnique({ where: { playerId: actor.id } }),
    ]);
    const stakes = [limit?.ownerMaxStake, limit?.managerMaxStake].filter((value): value is Prisma.Decimal => value !== null && value !== undefined).map(Number);
    return {
      closed,
      balance: Number(player.balance),
      maxStake: stakes.length ? Math.min(...stakes) : null,
      freeSpins: freeSpins && freeSpins.remaining > 0 ? { remaining: freeSpins.remaining, bet: Number(freeSpins.bet) } : null,
      /** Where the reels rest before the first spin: the last spin's grid. */
      grid: (recent[0]?.grid as string[][] | undefined) ?? null,
      recent: recent.map(spinView),
      game: {
        reels: REELS,
        rows: ROWS,
        lines: LINES,
        bets: BETS,
        symbols: SYMBOLS,
        wild: WILD,
        scatter: SCATTER,
        lineShapes: LINE_SHAPES,
        /** In line bets (a tenth of the bet): [3, 4, 5] in a row. */
        linePays: LINE_PAYS,
        scatterPays: SCATTER_PAYS,
        freeSpins: FREE_SPINS,
        payoutRate: PAYOUT_RATE,
      },
    };
  }

  /**
   * One spin. A Player with free spins plays one of those, at the bet that
   * won them, whatever `bet` says; otherwise `bet` is one of BETS.
   */
  async spin(actor: Actor, bet: number, ipAddress?: string) {
    if (actor.role !== Role.PLAYER) throw new ForbiddenException("Only Players play in the Casino");
    const closed = await this.closedReason(actor);
    if (closed) throw new ForbiddenException(closed);
    if (!BETS.some((allowed) => allowed === bet)) throw new BadRequestException(`Choose a bet of ${BETS.map((b) => money(b)).join(", ")}`);
    const team = await assertOnTeam(this.prisma, actor);

    const result = await this.prisma.$transaction(async (tx) => {
      // One spin at a time per Player, and none while a bet is being placed.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
      const owed = await tx.casinoFreeSpins.findUnique({ where: { playerId: actor.id } });
      const free = Boolean(owed && owed.remaining > 0);
      const playedAt = free ? owed!.bet : new Prisma.Decimal(bet);
      const stake = free ? new Prisma.Decimal(0) : playedAt;
      if (!free) await this.limits.assertCanPlace(actor.id, Number(stake));

      const round: Round = playRound(this.rng);
      // A line bet is a tenth of the bet; every bet is a whole number of cents per line, so this is exact.
      const win = playedAt.div(LINES).mul(round.win).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
      const net = win.sub(stake);
      // A paid spin needs the stake in the balance; a free spin costs nothing, so it plays even on an empty balance.
      const moved = await tx.user.updateMany({ where: { id: actor.id, ...(free ? {} : { balance: { gte: stake } }) }, data: { balance: { increment: net } } });
      if (moved.count === 0) throw new BadRequestException("Your balance is too low for this bet. Pick a smaller one, or ask your Manager for a top-up.");

      const left = (free ? owed!.remaining - 1 : owed?.remaining ?? 0) + round.freeSpins;
      if (left > 0) {
        await tx.casinoFreeSpins.upsert({
          where: { playerId: actor.id },
          create: { playerId: actor.id, remaining: left, bet: playedAt },
          // New free spins won on a paid spin play at that spin's bet.
          update: { remaining: left, ...(free ? {} : { bet: playedAt }) },
        });
      } else if (owed) {
        await tx.casinoFreeSpins.delete({ where: { playerId: actor.id } });
      }

      const now = new Date();
      const spin = await tx.casinoSpin.create({
        data: {
          playerId: actor.id,
          ownerId: team.ownerId,
          managerId: team.managerId,
          ownerRate: team.ownerRate,
          managerRate: team.managerRate,
          bet: playedAt,
          stake,
          win,
          free,
          freeSpinsWon: round.freeSpins,
          grid: round.grid,
          stops: round.stops,
          lines: { lines: round.lines, scatter: round.scatter },
          createdAt: now,
        },
        select: spinSelect,
      });
      // Counts in the team's results and commission like a settled bet (0 bets, the stake and the win).
      await tx.settlementEntry.create({
        data: { casinoSpinId: spin.id, playerId: actor.id, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate, managerRate: team.managerRate, bets: 0, stake, payout: win, createdAt: now },
      });
      const spins = await tx.casinoSpin.count({ where: { playerId: actor.id, createdAt: { gte: startOfDay(now) } } });
      const reason = spins === 1 ? "Casino: 1 spin" : `Casino: ${spins} spins`;
      await tx.balanceTransaction.upsert({
        where: { id: ledgerLineId(actor.id, now) },
        create: { id: ledgerLineId(actor.id, now), toUserId: actor.id, actorId: actor.id, type: BalanceTransactionType.CASINO, amount: net, reason, createdAt: now },
        update: { amount: { increment: net }, reason },
      });
      const balance = (await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { balance: true } })).balance;
      return { spin, round, win, net, balance, freeSpinsLeft: left, free };
    });

    await this.realtime.publishBalances([actor.id]);
    if (result.net.isNegative()) await this.users.alertLowBalance(actor.id, Number(result.net.abs()));
    if (result.round.freeSpins > 0 || result.win.greaterThanOrEqualTo(result.spin.bet.mul(100))) {
      // Worth a line in the audit log: free spins won, or a win of 100 times the bet or more.
      await this.audit.log({ actorId: actor.id, action: "casino.big_win", targetId: actor.id, ipAddress, metadata: { spinId: result.spin.id, bet: Number(result.spin.bet), win: Number(result.win), freeSpins: result.round.freeSpins } });
    }
    return {
      spin: spinView(result.spin),
      grid: result.round.grid,
      lines: result.round.lines.map((line) => ({ ...line, win: inMoney(result.spin.bet, line.win) })),
      scatter: result.round.scatter ? { ...result.round.scatter, win: inMoney(result.spin.bet, result.round.scatter.win) } : null,
      win: Number(result.win),
      free: result.free,
      freeSpinsWon: result.round.freeSpins,
      freeSpins: result.freeSpinsLeft > 0 ? { remaining: result.freeSpinsLeft, bet: Number(result.spin.bet) } : null,
      balance: Number(result.balance),
    };
  }

  /**
   * Super Admin, Owners and Managers: whether the Casino is open, and how it
   * did in a period, per Player. Super Admin sees every team, an Owner
   * their own, a Manager their own Players.
   */
  async admin(actor: Actor, fromInput?: string, toInput?: string) {
    if (actor.role === Role.PLAYER) throw new ForbiddenException("Players can't see this");
    const period = this.commissions.period(fromInput, toInput);
    const scope = actor.role === Role.OWNER ? Prisma.sql`s.owner_id = ${actor.id}` : actor.role === Role.MANAGER ? Prisma.sql`s.manager_id = ${actor.id}` : Prisma.sql`TRUE`;
    const rows = await this.prisma.$queryRaw<Array<{ player_id: string; username: string; spins: bigint; staked: Prisma.Decimal; won: Prisma.Decimal }>>`
      SELECT s.player_id, u.username, COUNT(*) AS spins, SUM(s.stake) AS staked, SUM(s.win) AS won
      FROM casino_spins s JOIN users u ON u.id = s.player_id
      WHERE ${scope} AND s.created_at >= ${period.from} AND s.created_at < ${period.to}
      GROUP BY s.player_id, u.username
    `;
    const players = rows
      .map((row) => {
        const staked = Number(row.staked);
        const won = Number(row.won);
        return { id: row.player_id, username: row.username, spins: Number(row.spins), staked, won, net: Math.round((staked - won) * 100) / 100 };
      })
      .sort((a, b) => b.staked - a.staked || a.username.localeCompare(b.username));
    const totals = players.reduce((sum, player) => ({ spins: sum.spins + player.spins, staked: sum.staked + player.staked, won: sum.won + player.won }), { spins: 0, staked: 0, won: 0 });

    const platform = await this.prisma.platformSettings.findUnique({ where: { id: "default" }, select: { casinoEnabled: true } });
    const owners =
      actor.role === Role.SUPER_ADMIN || actor.role === Role.OWNER
        ? await this.prisma.user.findMany({
            where: actor.role === Role.OWNER ? { id: actor.id } : { role: Role.OWNER },
            orderBy: { username: "asc" },
            select: { id: true, username: true, casinoEnabled: true },
          })
        : [];
    const myOwner = actor.role === Role.MANAGER && actor.parentId ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { casinoEnabled: true } }) : null;
    return {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      siteOpen: Boolean(platform?.casinoEnabled),
      /** Which switches this viewer can change: Super Admin both, an Owner their team's, a Manager none. */
      canSwitchSite: actor.role === Role.SUPER_ADMIN,
      teams: owners.map((owner) => ({ ownerId: owner.id, username: owner.username, open: owner.casinoEnabled })),
      /** A Manager's team: whether their Owner has it open. */
      teamOpen: actor.role === Role.MANAGER ? Boolean(myOwner?.casinoEnabled) : null,
      totals: {
        ...totals,
        staked: Math.round(totals.staked * 100) / 100,
        won: Math.round(totals.won * 100) / 100,
        net: Math.round((totals.staked - totals.won) * 100) / 100,
        /** What spins paid back, in percent of what they cost; null before any spin. */
        payoutRate: totals.staked > 0 ? Math.round((totals.won / totals.staked) * 1000) / 10 : null,
      },
      players,
    };
  }

  /** Opens or closes the Casino: for the site (Super Admin, no ownerId) or for one Owner's team. */
  async setOpen(actor: Actor, open: boolean, ownerId?: string, ipAddress?: string) {
    if (actor.role === Role.SUPER_ADMIN && !ownerId) {
      await this.prisma.platformSettings.upsert({ where: { id: "default" }, create: { id: "default", casinoEnabled: open }, update: { casinoEnabled: open } });
      await this.audit.log({ actorId: actor.id, action: open ? "casino.open_site" : "casino.close_site", ipAddress });
      return { open };
    }
    const target = ownerId ?? actor.id;
    if (actor.role === Role.OWNER && target !== actor.id) throw new ForbiddenException("Owners can only open or close the Casino for their own team");
    if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.OWNER) throw new ForbiddenException("Only Super Admin and Owners can open or close the Casino");
    const owner = await this.prisma.user.findUnique({ where: { id: target }, select: { role: true } });
    if (owner?.role !== Role.OWNER) throw new NotFoundException("Owner not found");
    await this.prisma.user.update({ where: { id: target }, data: { casinoEnabled: open } });
    await this.audit.log({ actorId: actor.id, action: open ? "casino.open_team" : "casino.close_team", targetId: target, ipAddress });
    return { open, ownerId: target };
  }
}
