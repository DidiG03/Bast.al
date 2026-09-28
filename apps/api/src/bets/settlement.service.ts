import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BetStatus, EventStatus, NotificationSeverity, NotificationType, Prisma, SelectionResult } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { UsersService } from "../users/users.service";
import { betSelect, betView } from "./bets.service";
import { accumulatorOutcome, gradeSelection, payoutFor } from "./grading";

type Change = { playerId: string; eventName: string; delta: Prisma.Decimal; status: BetStatus; voidReason?: string | null; accumulator?: boolean };

const money = (value: Prisma.Decimal | number) => `$${Number(value).toFixed(2)}`;

/**
 * Pays bets out. Every SETTLEMENT_INTERVAL_MS (one minute by default) it
 * settles the open bets on matches the feed reports as finished (from the
 * 90-minute score) or cancelled (refunded). Super Admin can also void a bet
 * or a whole match, and correct a result, which re-settles bets that were
 * already paid.
 *
 * Each bet is moved with a conditional update on its current status and
 * payout, and the Player's balance changes in the same transaction by the
 * difference, so running twice (or on two API instances) never pays twice.
 */
@Injectable()
export class SettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SettlementService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    const every = Number(process.env.SETTLEMENT_INTERVAL_MS) || 60_000;
    this.timer = setInterval(() => void this.settleDue(), every);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Settles every finished or cancelled match that still has open bets. */
  async settleDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let settled = 0;
    try {
      const events = await this.prisma.event.findMany({
        where: {
          OR: [{ status: EventStatus.COMPLETED, resultHome: { not: null }, resultAway: { not: null } }, { status: EventStatus.CANCELLED }],
          markets: {
            some: {
              selections: {
                some: { OR: [{ bets: { some: { status: BetStatus.OPEN } } }, { legs: { some: { result: null, voidReason: null, bet: { voidReason: null } } } }] },
              },
            },
          },
        },
        select: { id: true },
        take: 50,
      });
      for (const event of events) settled += (await this.settleEvent(event.id)).length;
    } catch (error) {
      this.logger.warn(`Settlement failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
    return settled;
  }

  /**
   * Grades a match's selections and settles its bets. With `regrade`, bets
   * already settled are corrected too (after Super Admin changed the result);
   * bets Super Admin voided by hand always stay void.
   */
  async settleEvent(eventId: string, regrade = false): Promise<Change[]> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { markets: { include: { selections: { select: { id: true, key: true, result: true } } } } },
    });
    if (!event) return [];

    const grades = new Map<string, SelectionResult | null>();
    for (const market of event.markets) {
      for (const selection of market.selections) {
        let grade: SelectionResult | null = null;
        if (event.status === EventStatus.CANCELLED) grade = SelectionResult.VOID;
        else if (event.status === EventStatus.COMPLETED && event.resultHome !== null && event.resultAway !== null) {
          grade = gradeSelection(market.key, selection.key, event.resultHome, event.resultAway);
        }
        grades.set(selection.id, grade);
        if (grade !== null && grade !== selection.result) {
          await this.prisma.selection.update({ where: { id: selection.id }, data: { result: grade } });
        }
      }
    }

    const bets = await this.prisma.bet.findMany({
      where: {
        selectionId: { in: [...grades.keys()] },
        ...(regrade ? { voidReason: null } : { status: BetStatus.OPEN }),
      },
      select: { id: true, playerId: true, stake: true, odds: true, payout: true, status: true, selectionId: true },
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const grade = grades.get(bet.selectionId!);
      if (!grade || bet.odds === null) continue;
      const status = grade as BetStatus;
      const change = await this.move(bet, status, payoutFor(status, bet.stake, bet.odds), null);
      if (change) changes.push({ ...change, eventName: event.name });
    }

    // Accumulator legs on this match: record each leg's result, then work
    // out the whole bet again from all its legs.
    const legs = await this.prisma.betLeg.findMany({
      where: { selectionId: { in: [...grades.keys()] }, voidReason: null, bet: { voidReason: null } },
      select: { id: true, selectionId: true, result: true, betId: true },
    });
    const touched = new Set<string>();
    for (const leg of legs) {
      const grade = grades.get(leg.selectionId);
      if (!grade) continue;
      if (grade !== leg.result) await this.prisma.betLeg.update({ where: { id: leg.id }, data: { result: grade } });
      touched.add(leg.betId);
    }
    changes.push(...(await this.resettleAccumulators([...touched], regrade)));

    await this.announce(changes, regrade ? "corrected" : "settled");
    return changes;
  }

  /**
   * Settles accumulators from their legs. Without `regrade` only open ones
   * move (a lost one is final until a result is corrected); with it, a
   * settled one can move again, even back to open.
   */
  private async resettleAccumulators(betIds: string[], regrade: boolean): Promise<Change[]> {
    if (betIds.length === 0) return [];
    const bets = await this.prisma.bet.findMany({
      where: { id: { in: betIds }, voidReason: null, ...(regrade ? {} : { status: BetStatus.OPEN }) },
      select: { id: true, playerId: true, stake: true, payout: true, status: true, description: true, legs: { select: { odds: true, result: true } } },
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const outcome = accumulatorOutcome(bet.legs);
      const payout = outcome.status === BetStatus.OPEN ? new Prisma.Decimal(0) : payoutFor(outcome.status, bet.stake, outcome.odds);
      const change = await this.move(bet, outcome.status, payout, null);
      if (change) changes.push({ ...change, eventName: bet.description ?? "Accumulator", accumulator: true });
    }
    return changes;
  }

  /** Super Admin: sets the score bets settle on, and re-settles the match. */
  async correctResult(actor: Actor, eventId: string, home: number, away: number) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true, status: true, startsAt: true, resultHome: true, resultAway: true } });
    if (!event) throw new NotFoundException("Match not found");
    if (event.startsAt > new Date()) throw new BadRequestException("This match hasn't started yet");
    if (event.status === EventStatus.CANCELLED) throw new BadRequestException("This match was cancelled and its bets refunded");
    await this.prisma.event.update({
      where: { id: eventId },
      data: { resultHome: home, resultAway: away, resultSource: "manual", status: EventStatus.COMPLETED },
    });
    const changes = await this.settleEvent(eventId, true);
    await this.audit.log({
      actorId: actor.id,
      action: "bet.result_correct",
      metadata: { eventId, event: event.name, from: event.resultHome === null ? null : `${event.resultHome}-${event.resultAway}`, to: `${home}-${away}`, betsChanged: changes.length },
    });
    return { eventId, result: { home, away }, betsChanged: changes.length };
  }

  /** Super Admin: voids one bet and refunds the stake, whatever state it's in. */
  async voidBet(actor: Actor, betId: string, reason: string) {
    const bet = await this.prisma.bet.findUnique({
      where: { id: betId },
      select: { id: true, playerId: true, stake: true, payout: true, status: true, voidReason: true, description: true },
    });
    if (!bet) throw new NotFoundException("Bet not found");
    if (bet.status === BetStatus.VOID && bet.voidReason) throw new BadRequestException("This bet is already void");
    const change = await this.move(bet, BetStatus.VOID, bet.stake, reason);
    if (!change) throw new BadRequestException("This bet changed while you were voiding it. Refresh and try again.");
    await this.announce([{ ...change, eventName: bet.description ?? "A bet", voidReason: reason }], "voided");
    await this.audit.log({ actorId: actor.id, action: "bet.void", targetId: bet.playerId, metadata: { betId, reason, from: bet.status, refund: Number(change.delta) } });
    const updated = await this.prisma.bet.findUniqueOrThrow({ where: { id: betId }, select: { id: true, status: true, payout: true } });
    return { id: updated.id, status: updated.status, payout: Number(updated.payout) };
  }

  /** Super Admin: voids every bet on a match and stops new ones. */
  async voidEvent(actor: Actor, eventId: string, reason: string) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { id: true, name: true } });
    if (!event) throw new NotFoundException("Match not found");
    await this.prisma.event.update({ where: { id: eventId }, data: { suspended: true } });
    const bets = await this.prisma.bet.findMany({
      where: { selection: { market: { eventId } }, voidReason: null },
      select: { id: true, playerId: true, stake: true, payout: true, status: true },
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const change = await this.move(bet, BetStatus.VOID, bet.stake, reason);
      if (change) changes.push({ ...change, eventName: event.name, voidReason: reason });
    }
    // In an accumulator only this match's pick is voided; the rest still counts.
    const legs = await this.prisma.betLeg.findMany({ where: { selection: { market: { eventId } }, voidReason: null }, select: { id: true, betId: true } });
    for (const leg of legs) await this.prisma.betLeg.update({ where: { id: leg.id }, data: { result: SelectionResult.VOID, voidReason: reason } });
    const accaChanges = await this.resettleAccumulators([...new Set(legs.map((leg) => leg.betId))], true);
    changes.push(...accaChanges);
    await this.announce(changes, "voided");
    await this.audit.log({ actorId: actor.id, action: "bet.void_event", metadata: { eventId, event: event.name, reason, bets: changes.length } });
    return { eventId, betsVoided: changes.length };
  }

  /** Super Admin: matches with bets on them, newest first, for settling by hand. */
  async adminEvents() {
    const rows = await this.prisma.$queryRaw<Array<{ event_id: string; open: bigint; total: bigint; staked: Prisma.Decimal; open_staked: Prisma.Decimal }>>`
      SELECT m.event_id,
             COUNT(*) FILTER (WHERE b.status = 'OPEN') AS open,
             COUNT(*) AS total,
             COALESCE(SUM(b.stake), 0) AS staked,
             COALESCE(SUM(b.stake) FILTER (WHERE b.status = 'OPEN'), 0) AS open_staked
      FROM bets b
      LEFT JOIN bet_legs l ON l.bet_id = b.id
      JOIN selections s ON s.id = COALESCE(l.selection_id, b.selection_id)
      JOIN markets m ON m.id = s.market_id
      GROUP BY m.event_id
    `;
    const stats = new Map(rows.map((r) => [r.event_id, r]));
    const events = await this.prisma.event.findMany({
      where: { id: { in: [...stats.keys()] } },
      orderBy: { startsAt: "desc" },
      take: 100,
      select: { id: true, name: true, league: true, startsAt: true, status: true, homeScore: true, awayScore: true, resultHome: true, resultAway: true, resultSource: true, suspended: true },
    });
    const now = new Date();
    return events.map((event) => {
      const stat = stats.get(event.id)!;
      const open = Number(stat.open);
      return {
        ...event,
        result: event.resultHome === null || event.resultAway === null ? null : { home: event.resultHome, away: event.resultAway },
        bets: { open, total: Number(stat.total), staked: Number(stat.staked), openStaked: Number(stat.open_staked) },
        /** Started long ago but still has open bets: the feed hasn't settled it, so it may need a hand. */
        needsAttention: open > 0 && event.startsAt.getTime() < now.getTime() - 3 * 3_600_000,
      };
    });
  }

  /** Super Admin: recent bets, to find one to void. */
  async adminBets(filter: { status?: BetStatus; player?: string; eventId?: string }) {
    const bets = await this.prisma.bet.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.player ? { player: { username: { contains: filter.player.toLowerCase() } } } : {}),
        ...(filter.eventId ? { OR: [{ selection: { market: { eventId: filter.eventId } } }, { legs: { some: { selection: { market: { eventId: filter.eventId } } } } }] } : {}),
      },
      orderBy: { placedAt: "desc" },
      take: 100,
      select: { ...betSelectWithPlayer },
    });
    return bets.map(({ player, ...bet }) => ({ ...betView(bet), player }));
  }

  /**
   * Moves one bet to `status` paying `payout`, and changes the Player's
   * balance by the difference from what it paid before. Returns null when
   * nothing changed or someone else moved the bet first.
   */
  private async move(
    bet: { id: string; playerId: string; stake: Prisma.Decimal; payout: Prisma.Decimal; status: BetStatus },
    status: BetStatus,
    payout: Prisma.Decimal,
    voidReason: string | null,
  ): Promise<Omit<Change, "eventName"> | null> {
    if (bet.status === status && bet.payout.equals(payout) && !voidReason) return null;
    const delta = payout.sub(bet.payout);
    const moved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: bet.status, payout: bet.payout },
        data: { status, payout, settledAt: status === BetStatus.OPEN ? null : new Date(), ...(voidReason ? { voidReason } : {}) },
      });
      if (updated.count === 0) return false;
      if (!delta.isZero()) await tx.user.update({ where: { id: bet.playerId }, data: { balance: { increment: delta } } });
      return true;
    });
    return moved ? { playerId: bet.playerId, delta, status, voidReason } : null;
  }

  /** Live balances, a refresh of the Player's bets, and one notification per Player per match. */
  private async announce(changes: Change[], kind: "settled" | "corrected" | "voided") {
    if (changes.length === 0) return;
    const players = [...new Set(changes.map((c) => c.playerId))];
    await this.realtime.publishBalances(players);
    for (const playerId of players) await this.realtime.publish(playerId, { type: "bets.changed" });

    // Accumulators get a message of their own, from where the whole bet now stands.
    for (const change of changes.filter((c) => c.accumulator)) {
      const { playerId, delta, status } = change;
      const back = delta.isNegative() ? ` ${money(delta.abs())} was taken back from your balance.` : "";
      const [title, message] =
        status === BetStatus.WON
          ? ["Your accumulator won", delta.isPositive() ? `${money(delta)} was added to your balance.` : back.trim() || "Your accumulator won."]
          : status === BetStatus.LOST
            ? ["Accumulator settled", `Your accumulator lost.${back}`]
            : status === BetStatus.VOID
              ? ["Accumulator refunded", `Every pick in your accumulator was void, so your stake went back to your balance.${back}`]
              : ["Result corrected", `A result in your accumulator was corrected, so it's open again.${back}`];
      await this.notifications.create({
        userId: playerId,
        type: NotificationType.BET_SETTLED,
        severity: status === BetStatus.WON ? NotificationSeverity.SUCCESS : NotificationSeverity.INFO,
        title,
        message,
        deepLink: status === BetStatus.OPEN ? "/dashboard/bet?tab=open" : "/dashboard/bet?tab=settled",
      });
      if (delta.isNegative()) await this.users.alertLowBalance(playerId, Number(delta.abs()));
    }

    const grouped = new Map<string, Change[]>();
    for (const change of changes.filter((c) => !c.accumulator)) {
      const key = `${change.playerId}\n${change.eventName}`;
      grouped.set(key, [...(grouped.get(key) ?? []), change]);
    }
    for (const group of grouped.values()) {
      const { playerId, eventName } = group[0];
      const delta = group.reduce((sum, c) => sum.add(c.delta), new Prisma.Decimal(0));
      const won = group.filter((c) => c.status === BetStatus.WON).length;
      let title = "Bet settled";
      let message: string;
      if (kind === "voided") {
        title = "Bet voided";
        message = `${eventName}: ${group.length === 1 ? "your bet was" : `${group.length} bets were`} voided (${group[0].voidReason}). ${delta.isNegative() ? `${money(delta.abs())} was taken back` : `${money(delta)} went back to your balance`}.`;
      } else if (kind === "corrected") {
        title = "Result corrected";
        message = `${eventName}: the result was corrected. ${delta.isZero() ? "Your balance didn't change." : delta.isNegative() ? `${money(delta.abs())} was taken back from your balance.` : `${money(delta)} was added to your balance.`}`;
      } else if (won > 0) {
        title = "You won";
        message = `${eventName}: ${money(delta)} was added to your balance.`;
      } else if (group.every((c) => c.status === BetStatus.VOID)) {
        title = "Bet refunded";
        message = `${eventName} was called off. ${money(delta)} went back to your balance.`;
      } else {
        message = `${eventName}: ${group.length === 1 ? "your bet lost" : "your bets lost"}.`;
      }
      await this.notifications.create({
        userId: playerId,
        type: NotificationType.BET_SETTLED,
        severity: won > 0 && kind === "settled" ? NotificationSeverity.SUCCESS : NotificationSeverity.INFO,
        title,
        message,
        deepLink: "/dashboard/bet?tab=settled",
      });
      if (delta.isNegative()) await this.users.alertLowBalance(playerId, Number(delta.abs()));
    }
  }
}

const betSelectWithPlayer = { ...betSelect, player: { select: { id: true, username: true } } } satisfies Prisma.BetSelect;
