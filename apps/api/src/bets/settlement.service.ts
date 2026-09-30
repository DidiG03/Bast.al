import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { BalanceTransactionType, BetStatus, EventStatus, NotificationSeverity, NotificationType, Prisma, Role, SelectionResult } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { Actor } from "../auth/permissions";
import { NotificationsService } from "../notifications/notifications.service";
import { UNPLAYED_VOID_MS } from "../odds/odds-sync.service";
import { PrismaService } from "../prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { UsersService } from "../users/users.service";
import { betSelect, betView } from "./bets.service";
import { accumulatorOutcome, gradeSelection, payoutFor } from "./grading";
import { teamOf } from "./team";

type Change = { playerId: string; eventName: string; delta: Prisma.Decimal; status: BetStatus; voidReason?: string | null; accumulator?: boolean };

const money = (value: Prisma.Decimal | number) => `$${Number(value).toFixed(2)}`;

/** What `move` needs to know about a bet. */
const movable = {
  id: true,
  playerId: true,
  stake: true,
  payout: true,
  status: true,
  description: true,
  settledAt: true,
  ownerId: true,
  managerId: true,
  ownerRate: true,
  managerRate: true,
} satisfies Prisma.BetSelect;

type MovableBet = Prisma.BetGetPayload<{ select: typeof movable }>;

/** Only won and lost bets count in a team's results; a void one was refunded. */
function counted(status: BetStatus, stake: Prisma.Decimal, payout: Prisma.Decimal) {
  const zero = new Prisma.Decimal(0);
  return status === BetStatus.WON || status === BetStatus.LOST ? { bets: 1, stake, payout } : { bets: 0, stake: zero, payout: zero };
}

/** The id of the row that records where a bet settled before the journal existed. Fixed, so it's only ever written once. */
const baseEntryId = (betId: string) => `bf_${betId}`;

/** A score the feed changed is used once it has stayed the same this long, so a feed that flips back and forth doesn't move money each time. */
const FEED_CORRECTION_DELAY_MS = 10 * 60_000;
const UNPLAYED_HOURS = Math.round(UNPLAYED_VOID_MS / 3_600_000);
const NOT_PLAYED = `Not played within ${UNPLAYED_HOURS} hours of kick-off`;
const MOVED = `Moved more than ${UNPLAYED_HOURS} hours after the original kick-off`;

/** Open bets, or accumulator picks still waiting on an open bet: what an unplayed match can still refund. */
const hasOpenBets = {
  markets: {
    some: {
      selections: {
        some: { OR: [{ bets: { some: { status: BetStatus.OPEN } } }, { legs: { some: { result: null, voidReason: null, bet: { status: BetStatus.OPEN, voidReason: null } } } }] },
      },
    },
  },
} satisfies Prisma.EventWhereInput;

/**
 * Pays bets out. Every SETTLEMENT_INTERVAL_MS (one minute by default) it
 * settles the open bets on matches the feed reports as finished (from the
 * 90-minute score) or cancelled (refunded), re-settles matches whose score
 * the feed corrected, and refunds bets on matches not played within
 * UNPLAYED_VOID_MS of kick-off (postponed, never finished, or moved to a
 * later date). Super Admin can also void a bet or a whole match, and correct
 * a result, which re-settles bets that were already paid.
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

  async onModuleInit() {
    await this.backfillJournal().catch((error) => this.logger.error(`Couldn't fill in the settlement journal: ${error instanceof Error ? error.message : String(error)}`));
    const every = Number(process.env.SETTLEMENT_INTERVAL_MS) || 60_000;
    this.timer = setInterval(() => void this.settleDue(), every);
  }

  /**
   * For bets from before teams, rates and the settlement journal were
   * recorded: the team and rates the Player has now, and one journal row per
   * settled bet, dated when it settled. Safe to run on every start and on
   * several instances at once; after the first run there's nothing to do.
   */
  async backfillJournal() {
    const teams = await this.prisma.$executeRaw`
      UPDATE bets b SET
        owner_id = CASE WHEN parent.role = 'OWNER' THEN parent.id WHEN parent.role = 'MANAGER' AND grand.role = 'OWNER' THEN grand.id END,
        manager_id = CASE WHEN parent.role = 'MANAGER' THEN parent.id END,
        owner_rate = CASE WHEN parent.role = 'OWNER' THEN parent.commission_rate WHEN parent.role = 'MANAGER' AND grand.role = 'OWNER' THEN grand.commission_rate ELSE 0 END,
        manager_rate = CASE WHEN parent.role = 'MANAGER' THEN parent.commission_rate ELSE 0 END
      FROM users p
      LEFT JOIN users parent ON parent.id = p.parent_id
      LEFT JOIN users grand ON grand.id = parent.parent_id
      WHERE b.player_id = p.id AND b.owner_rate IS NULL
    `;
    const entries = await this.prisma.$executeRaw`
      INSERT INTO settlement_entries (id, bet_id, player_id, owner_id, manager_id, owner_rate, manager_rate, bets, stake, payout, created_at)
      SELECT 'bf_' || b.id, b.id, b.player_id, b.owner_id, b.manager_id, COALESCE(b.owner_rate, 0), COALESCE(b.manager_rate, 0), 1, b.stake, b.payout, COALESCE(b.settled_at, b.placed_at)
      FROM bets b
      WHERE b.status IN ('WON', 'LOST') AND NOT EXISTS (SELECT 1 FROM settlement_entries e WHERE e.bet_id = b.id)
      ON CONFLICT (id) DO NOTHING
    `;
    if (teams > 0 || entries > 0) this.logger.log(`Recorded the team for ${teams} earlier bets and journalled ${entries} earlier settlements`);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Settles finished and cancelled matches, applies the feed's corrections, and refunds unplayed matches. Returns how many bets moved. */
  async settleDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let settled = 0;
    try {
      // Each step on its own, so one failing doesn't hold up the others.
      for (const step of [this.settleFinished, this.applyFeedCorrections, this.refundUnplayed]) {
        settled += await step.call(this).catch((error: unknown) => {
          this.logger.warn(`Settlement (${step.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
          return 0;
        });
      }
    } finally {
      this.running = false;
    }
    return settled;
  }

  /** Every finished or cancelled match that still has open bets. */
  private async settleFinished(): Promise<number> {
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
    let settled = 0;
    for (const event of events) settled += (await this.settleEvent(event.id)).length;
    return settled;
  }

  /**
   * Matches whose score the feed changed after their bets were settled (see
   * OddsSyncService.recordResult): once the new score has held for
   * FEED_CORRECTION_DELAY_MS, the bets are settled again on it, like a
   * correction Super Admin makes by hand, and Super Admin is told.
   */
  private async applyFeedCorrections(): Promise<number> {
    const events = await this.prisma.event.findMany({
      where: { resultChangedAt: { not: null, lte: new Date(Date.now() - FEED_CORRECTION_DELAY_MS) } },
      select: { id: true, name: true, status: true, resultSource: true, resultHome: true, resultAway: true, resultChangedAt: true },
      take: 20,
    });
    let settled = 0;
    for (const event of events) {
      // A result Super Admin set by hand was settled when they set it.
      const changes = event.status === EventStatus.COMPLETED && event.resultSource === "feed" ? await this.settleEvent(event.id, true) : [];
      // Cleared only if the feed hasn't changed it again meanwhile; then it waits its turn once more.
      await this.prisma.event.updateMany({ where: { id: event.id, resultChangedAt: event.resultChangedAt }, data: { resultChangedAt: null } });
      if (changes.length === 0) continue;
      settled += changes.length;
      const score = `${event.resultHome}-${event.resultAway}`;
      await this.audit.log({ action: "bet.result_feed_correct", metadata: { eventId: event.id, event: event.name, to: score, betsChanged: changes.length } });
      const admins = await this.prisma.user.findMany({ where: { role: Role.SUPER_ADMIN }, select: { id: true } });
      for (const admin of admins) {
        await this.notifications.create({
          userId: admin.id,
          type: NotificationType.BET_SETTLED,
          severity: NotificationSeverity.WARNING,
          title: "Result corrected by the feed",
          message:
            changes.length === 1
              ? `The feed changed ${event.name} to ${score}, so 1 bet was settled again.`
              : `The feed changed ${event.name} to ${score}, so ${changes.length} bets were settled again.`,
          deepLink: "/dashboard/settlement",
          metadata: { eventId: event.id, betsChanged: changes.length },
        });
      }
    }
    return settled;
  }

  /**
   * Refunds open bets on matches that weren't played within UNPLAYED_VOID_MS
   * of kick-off: postponed, or never reported finished. A match the feed
   * moved to a later date refunds the bets placed before the move; bets
   * placed for the new date stand.
   */
  private async refundUnplayed(): Promise<number> {
    let refunded = 0;
    const moved = await this.prisma.event.findMany({ where: { rescheduledAt: { not: null } }, select: { id: true, name: true, rescheduledAt: true }, take: 50 });
    for (const event of moved) {
      refunded += (await this.refund(event, MOVED, event.rescheduledAt!)).length;
      await this.prisma.event.updateMany({ where: { id: event.id, rescheduledAt: event.rescheduledAt }, data: { rescheduledAt: null } });
    }
    const unplayed = await this.prisma.event.findMany({
      where: {
        externalId: { not: null },
        status: { in: [EventStatus.UPCOMING, EventStatus.LIVE, EventStatus.POSTPONED] },
        startsAt: { lt: new Date(Date.now() - UNPLAYED_VOID_MS) },
        ...hasOpenBets,
      },
      select: { id: true, name: true },
      take: 50,
    });
    for (const event of unplayed) refunded += (await this.refund(event, NOT_PLAYED)).length;
    return refunded;
  }

  /** Voids a match's open bets (only those placed before `placedBefore`, if given) and the matching accumulator picks, refunding the stakes. */
  private async refund(event: { id: string; name: string }, reason: string, placedBefore?: Date): Promise<Change[]> {
    const placed = placedBefore ? { placedAt: { lt: placedBefore } } : {};
    const bets = await this.prisma.bet.findMany({
      where: { selection: { market: { eventId: event.id } }, status: BetStatus.OPEN, voidReason: null, ...placed },
      select: movable,
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const change = await this.move(bet, BetStatus.VOID, bet.stake, reason);
      if (change) changes.push({ ...change, eventName: event.name, voidReason: reason });
    }
    // In an accumulator only this match's pick is void; the rest still counts.
    const legs = await this.prisma.betLeg.findMany({
      where: { selection: { market: { eventId: event.id } }, result: null, voidReason: null, bet: { status: BetStatus.OPEN, voidReason: null, ...placed } },
      select: { id: true, betId: true },
    });
    for (const leg of legs) await this.prisma.betLeg.update({ where: { id: leg.id }, data: { result: SelectionResult.VOID, voidReason: reason } });
    changes.push(...(await this.resettleAccumulators([...new Set(legs.map((leg) => leg.betId))], false)));
    await this.announce(changes, "voided");
    if (bets.length > 0 || legs.length > 0) {
      await this.audit.log({ action: "bet.void_unplayed", metadata: { eventId: event.id, event: event.name, reason, bets: bets.length, accumulatorPicks: legs.length } });
    }
    return changes;
  }

  /**
   * Grades a match's selections and settles its bets. With `regrade`, bets
   * already settled are corrected too (after Super Admin changed the result);
   * bets Super Admin voided by hand always stay void.
   */
  async settleEvent(eventId: string, regrade = false, actorId: string | null = null): Promise<Change[]> {
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
          const half = event.resultHalfHome !== null && event.resultHalfAway !== null ? { home: event.resultHalfHome, away: event.resultHalfAway } : null;
          grade = gradeSelection(market.key, selection.key, event.resultHome, event.resultAway, half, statsOf(event));
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
      select: { ...movable, odds: true, selectionId: true },
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const grade = grades.get(bet.selectionId!);
      if (!grade || bet.odds === null) continue;
      const status = grade as BetStatus;
      const change = await this.move(bet, status, payoutFor(status, bet.stake, bet.odds), null, actorId);
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
    changes.push(...(await this.resettleAccumulators([...touched], regrade, actorId)));

    await this.announce(changes, regrade ? "corrected" : "settled");
    return changes;
  }

  /**
   * Settles accumulators from their legs. Without `regrade` only open ones
   * move (a lost one is final until a result is corrected); with it, a
   * settled one can move again, even back to open.
   */
  private async resettleAccumulators(betIds: string[], regrade: boolean, actorId: string | null = null): Promise<Change[]> {
    if (betIds.length === 0) return [];
    const bets = await this.prisma.bet.findMany({
      where: { id: { in: betIds }, voidReason: null, ...(regrade ? {} : { status: BetStatus.OPEN }) },
      select: { ...movable, legs: { select: { odds: true, result: true } } },
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const outcome = accumulatorOutcome(bet.legs);
      const payout = outcome.status === BetStatus.OPEN ? new Prisma.Decimal(0) : payoutFor(outcome.status, bet.stake, outcome.odds);
      const change = await this.move(bet, outcome.status, payout, null, actorId);
      if (change) changes.push({ ...change, eventName: bet.description ?? "Accumulator", accumulator: true });
    }
    return changes;
  }

  /** Super Admin: sets the score bets settle on, and re-settles the match. */
  async correctResult(
    actor: Actor,
    eventId: string,
    home: number,
    away: number,
    half: { home: number; away: number } | null = null,
    stats: { cornersHome: number; cornersAway: number; cardsHome: number; cardsAway: number } | null = null,
  ) {
    if (half && (half.home > home || half.away > away)) throw new BadRequestException("The half-time score can't be higher than the full-time score");
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, name: true, status: true, startsAt: true, resultHome: true, resultAway: true, resultHalfHome: true, resultHalfAway: true },
    });
    if (!event) throw new NotFoundException("Match not found");
    if (event.startsAt > new Date()) throw new BadRequestException("This match hasn't started yet");
    if (event.status === EventStatus.CANCELLED) throw new BadRequestException("This match was cancelled and its bets refunded");
    await this.prisma.event.update({
      where: { id: eventId },
      // Without a half-time score the one already stored stays, unless it no longer fits the new full-time score.
      data: {
        resultHome: home,
        resultAway: away,
        ...(half
          ? { resultHalfHome: half.home, resultHalfAway: half.away }
          : (event.resultHalfHome ?? 0) > home || (event.resultHalfAway ?? 0) > away
            ? { resultHalfHome: null, resultHalfAway: null }
            : {}),
        ...(stats
          ? {
              resultCornersHome: stats.cornersHome,
              resultCornersAway: stats.cornersAway,
              resultCardsHome: stats.cardsHome,
              resultCardsAway: stats.cardsAway,
              statsSource: "manual",
            }
          : {}),
        resultSource: "manual",
        status: EventStatus.COMPLETED,
      },
    });
    const changes = await this.settleEvent(eventId, true, actor.id);
    await this.audit.log({
      actorId: actor.id,
      action: "bet.result_correct",
      metadata: { eventId, event: event.name, from: event.resultHome === null ? null : `${event.resultHome}-${event.resultAway}`, to: `${home}-${away}`, halfTime: half ? `${half.home}-${half.away}` : undefined, stats: stats ?? undefined, betsChanged: changes.length },
    });
    return { eventId, result: { home, away }, betsChanged: changes.length };
  }

  /** Super Admin: voids one bet and refunds the stake, whatever state it's in. */
  async voidBet(actor: Actor, betId: string, reason: string) {
    const bet = await this.prisma.bet.findUnique({
      where: { id: betId },
      select: { ...movable, voidReason: true },
    });
    if (!bet) throw new NotFoundException("Bet not found");
    if (bet.status === BetStatus.VOID && bet.voidReason) throw new BadRequestException("This bet is already void");
    const change = await this.move(bet, BetStatus.VOID, bet.stake, reason, actor.id);
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
      select: movable,
    });
    const changes: Change[] = [];
    for (const bet of bets) {
      const change = await this.move(bet, BetStatus.VOID, bet.stake, reason, actor.id);
      if (change) changes.push({ ...change, eventName: event.name, voidReason: reason });
    }
    // In an accumulator only this match's pick is voided; the rest still counts.
    const legs = await this.prisma.betLeg.findMany({ where: { selection: { market: { eventId } }, voidReason: null }, select: { id: true, betId: true } });
    for (const leg of legs) await this.prisma.betLeg.update({ where: { id: leg.id }, data: { result: SelectionResult.VOID, voidReason: reason } });
    const accaChanges = await this.resettleAccumulators([...new Set(legs.map((leg) => leg.betId))], true, actor.id);
    changes.push(...accaChanges);
    await this.announce(changes, "voided");
    await this.audit.log({ actorId: actor.id, action: "bet.void_event", metadata: { eventId, event: event.name, reason, bets: changes.length } });
    return { eventId, betsVoided: changes.length };
  }

  /**
   * Matches with bets on them, newest first. Super Admin sees every bet, to
   * settle by hand; with `teamOf`, only that Owner's or Manager's Players'
   * bets are counted (Players they created, plus their Managers' Players).
   */
  async adminEvents(teamOf?: string) {
    const team = teamOf ? Prisma.sql`WHERE p.parent_id = ${teamOf} OR pm.parent_id = ${teamOf}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ event_id: string; open: bigint; total: bigint; staked: Prisma.Decimal; open_staked: Prisma.Decimal }>>`
      SELECT m.event_id,
             COUNT(*) FILTER (WHERE b.status = 'OPEN') AS open,
             COUNT(*) AS total,
             COALESCE(SUM(b.stake), 0) AS staked,
             COALESCE(SUM(b.stake) FILTER (WHERE b.status = 'OPEN'), 0) AS open_staked
      FROM bets b
      JOIN users p ON p.id = b.player_id
      LEFT JOIN users pm ON pm.id = p.parent_id
      LEFT JOIN bet_legs l ON l.bet_id = b.id
      JOIN selections s ON s.id = COALESCE(l.selection_id, b.selection_id)
      JOIN markets m ON m.id = s.market_id
      ${team}
      GROUP BY m.event_id
    `;
    const stats = new Map(rows.map((r) => [r.event_id, r]));
    const events = await this.prisma.event.findMany({
      where: { id: { in: [...stats.keys()] } },
      orderBy: { startsAt: "desc" },
      take: 100,
      select: { id: true, name: true, league: true, startsAt: true, status: true, homeScore: true, awayScore: true, resultHome: true, resultAway: true, resultHalfHome: true, resultHalfAway: true, resultCornersHome: true, resultCornersAway: true, resultCardsHome: true, resultCardsAway: true, statsSource: true, extraTime: true, resultSource: true, suspended: true },
    });
    const now = new Date();
    return events.map((event) => {
      const stat = stats.get(event.id)!;
      const open = Number(stat.open);
      return {
        ...event,
        result: event.resultHome === null || event.resultAway === null ? null : { home: event.resultHome, away: event.resultAway },
        halfTime: event.resultHalfHome === null || event.resultHalfAway === null ? null : { home: event.resultHalfHome, away: event.resultHalfAway },
        stats: statsOf(event),
        bets: { open, total: Number(stat.total), staked: Number(stat.staked), openStaked: Number(stat.open_staked) },
        /** Started long ago but still has open bets: the feed hasn't settled it, so it may need a hand. */
        needsAttention: open > 0 && event.startsAt.getTime() < now.getTime() - 3 * 3_600_000,
      };
    });
  }

  /** Recent bets: every Player's for Super Admin (to find one to void), or only the team's with `teamOf`. */
  async adminBets(filter: { status?: BetStatus; player?: string; playerId?: string; eventId?: string }, teamOf?: string) {
    const bets = await this.prisma.bet.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        player: {
          AND: [
            teamOf ? teamPlayers(teamOf) : {},
            filter.player ? { username: { contains: filter.player.toLowerCase() } } : {},
            filter.playerId ? { id: filter.playerId } : {},
          ],
        },
        ...(filter.eventId ? { OR: [{ selection: { market: { eventId: filter.eventId } } }, { legs: { some: { selection: { market: { eventId: filter.eventId } } } } }] } : {}),
      },
      orderBy: { placedAt: "desc" },
      take: 100,
      select: { ...betSelectWithPlayer },
    });
    return bets.map(({ player, ...bet }) => ({ ...betView(bet), player }));
  }

  /** Open bets per Player: how many and their total stake. Every Player for Super Admin, only the team's with `teamOf`. */
  async openByPlayer(teamOf?: string): Promise<Record<string, { bets: number; staked: number }>> {
    const groups = await this.prisma.bet.groupBy({
      by: ["playerId"],
      where: { status: BetStatus.OPEN, ...(teamOf ? { player: teamPlayers(teamOf) } : {}) },
      _count: { _all: true },
      _sum: { stake: true },
    });
    return Object.fromEntries(groups.map((g) => [g.playerId, { bets: g._count._all, staked: Number(g._sum.stake ?? 0) }]));
  }

  /**
   * Moves one bet to `status` paying `payout`, and changes the Player's
   * balance by the difference from what it paid before, with a matching
   * entry in their balance ledger and in the settlement journal. `actorId` is
   * Super Admin for a change made by hand, null when the feed settled it.
   * Returns null when nothing changed or someone else moved the bet first.
   *
   * The bet keeps the date it first settled: a later correction is dated in
   * the journal instead, so a week already reported and paid stays as it was.
   */
  private async move(
    bet: MovableBet,
    status: BetStatus,
    payout: Prisma.Decimal,
    voidReason: string | null,
    actorId: string | null = null,
  ): Promise<Omit<Change, "eventName"> | null> {
    if (bet.status === status && bet.payout.equals(payout) && !voidReason) return null;
    const delta = payout.sub(bet.payout);
    const settledAt = status === BetStatus.OPEN ? { settledAt: null } : bet.status === BetStatus.OPEN || !bet.settledAt ? { settledAt: new Date() } : {};
    const moved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.bet.updateMany({
        where: { id: bet.id, status: bet.status, payout: bet.payout },
        data: { status, payout, ...settledAt, ...(voidReason ? { voidReason } : {}) },
      });
      if (updated.count === 0) return false;
      if (!delta.isZero()) {
        await tx.user.update({ where: { id: bet.playerId }, data: { balance: { increment: delta } } });
        await tx.balanceTransaction.create({
          data: {
            toUserId: bet.playerId,
            actorId,
            type: BalanceTransactionType.BET_SETTLEMENT,
            amount: delta,
            reason: ledgerReason(bet.status, status, delta, bet.description ?? null, voidReason),
            betId: bet.id,
          },
        });
      }
      await this.journal(tx, bet, status, payout);
      return true;
    });
    return moved ? { playerId: bet.playerId, delta, status, voidReason } : null;
  }

  /** Records in the settlement journal what this move changes in the team's results. */
  private async journal(tx: Prisma.TransactionClient, bet: MovableBet, status: BetStatus, payout: Prisma.Decimal) {
    const before = counted(bet.status, bet.stake, bet.payout);
    const after = counted(status, bet.stake, payout);
    const change = { bets: after.bets - before.bets, stake: after.stake.sub(before.stake), payout: after.payout.sub(before.payout) };
    if (change.bets === 0 && change.stake.isZero() && change.payout.isZero()) return;

    // A bet placed before teams were recorded gets the team its Player has now.
    let team = { ownerId: bet.ownerId, managerId: bet.managerId, ownerRate: bet.ownerRate, managerRate: bet.managerRate };
    if (team.ownerRate === null || team.managerRate === null) {
      team = await teamOf(tx, bet.playerId);
      await tx.bet.update({ where: { id: bet.id }, data: team });
    }
    const row = { betId: bet.id, playerId: bet.playerId, ownerId: team.ownerId, managerId: team.managerId, ownerRate: team.ownerRate ?? 0, managerRate: team.managerRate ?? 0 };

    // Settled before the journal existed and not filled in yet: first record
    // where it stood, on the day it settled, so this move adds only the difference.
    if (before.bets > 0 && (await tx.settlementEntry.count({ where: { betId: bet.id } })) === 0) {
      await tx.settlementEntry.createMany({
        data: [{ id: baseEntryId(bet.id), ...row, ...before, createdAt: bet.settledAt ?? new Date() }],
        skipDuplicates: true,
      });
    }
    await tx.settlementEntry.create({ data: { ...row, ...change } });
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
      if (delta.isNegative()) await this.afterTakingBack(playerId, delta);
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
      if (delta.isNegative()) await this.afterTakingBack(playerId, delta);
    }
  }

  /** Money came back out of a Player's balance: warn if it's now low, or below zero. */
  private async afterTakingBack(playerId: string, delta: Prisma.Decimal) {
    await this.users.alertLowBalance(playerId, Number(delta.abs()));
    await this.users.alertNegativeBalance(playerId);
  }
}

const betSelectWithPlayer = { ...betSelect, player: { select: { id: true, username: true } } } satisfies Prisma.BetSelect;

/** What a settlement move says in the Player's balance ledger. */
export function ledgerReason(from: BetStatus, to: BetStatus, delta: Prisma.Decimal, description: string | null, voidReason: string | null): string {
  const what = description ?? "bet";
  if (to === BetStatus.VOID) return `Bet refunded: ${what}${voidReason ? ` (${voidReason})` : ""}`;
  // A bet that had already paid out and now pays less: a corrected result.
  if (from !== BetStatus.OPEN && delta.isNegative()) return `Bet corrected, payout taken back: ${what}`;
  if (from !== BetStatus.OPEN) return `Bet corrected: ${what}`;
  if (to === BetStatus.WON) return `Bet won: ${what}`;
  return `Bet settled: ${what}`;
}

/** An Owner's or Manager's Players: ones they created, plus their Managers' Players. */
function teamPlayers(teamOf: string): Prisma.UserWhereInput {
  return { OR: [{ parentId: teamOf }, { parent: { parentId: teamOf } }] };
}

/** The corners and cards a match settles on, once all four numbers are known. */
function statsOf(event: { resultCornersHome: number | null; resultCornersAway: number | null; resultCardsHome: number | null; resultCardsAway: number | null }) {
  const { resultCornersHome, resultCornersAway, resultCardsHome, resultCardsAway } = event;
  if (resultCornersHome === null || resultCornersAway === null || resultCardsHome === null || resultCardsAway === null) return null;
  return { cornersHome: resultCornersHome, cornersAway: resultCornersAway, cardsHome: resultCardsHome, cardsAway: resultCardsAway };
}
