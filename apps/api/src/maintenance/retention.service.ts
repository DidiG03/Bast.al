import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";

const DAY_MS = 86_400_000;
/** Rows deleted per statement, so a big clean-up never writes one huge burst to the database's log or holds locks for long. */
const SNAPSHOT_BATCH = 5_000;
const EVENT_BATCH = 100;
/** A breath between batches, so bets and spins keep going while it runs. */
const BATCH_PAUSE_MS = 50;

const pause = () => new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));

/** Days to keep each kind of short-lived data, from RETENTION_* env vars. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env) {
  const days = (name: string, fallback: number, min: number) => Math.max(min, Number(env[name]) || fallback);
  return {
    /**
     * Price-movement history. The chart only needs recent moves, and the
     * feed records around 10 MB of it a day: kept for a month it outgrew
     * the database's disk.
     */
    oddsHistory: days("RETENTION_ODDS_HISTORY_DAYS", 7, 7),
    /** Matches nobody bet on, counted from kick-off. Matches with bets are kept for good. */
    unusedEvents: days("RETENTION_UNUSED_EVENT_DAYS", 7, 7),
    /** Notifications already read or archived. */
    readNotifications: days("RETENTION_READ_NOTIFICATION_DAYS", 90, 30),
    /** Any notification, read or not. */
    notifications: days("RETENTION_NOTIFICATION_DAYS", 180, 30),
    /** Sign-in history on the Security page. */
    loginHistory: days("RETENTION_LOGIN_HISTORY_DAYS", 180, 30),
    /** Double-submit protection keys. They only matter for a day. */
    idempotencyKeys: 2,
  };
}

/**
 * Deletes data that only matters for a while, so the database doesn't grow
 * forever. Runs a couple of minutes after start and then every 6 hours; each
 * run is idempotent, so several API instances running it is harmless.
 *
 * Never touched: bets, the balance ledger, commission payouts, audit logs and
 * users. Those are the financial and security record. A match with any bet on
 * it is kept with all its markets (bets point at its selections).
 *
 * RETENTION_DISABLED=true turns it off.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.RETENTION_DISABLED === "true") return;
    this.timers.push(setTimeout(() => void this.run(), 2 * 60_000));
    this.timers.push(setInterval(() => void this.run(), 6 * 60 * 60_000));
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
  }

  /** Price history recorded before `cutoff`, a batch at a time. */
  private async deleteOldSnapshots(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const count = await this.prisma.$executeRaw`
        DELETE FROM odds_snapshots WHERE id IN (SELECT id FROM odds_snapshots WHERE recorded_at < ${cutoff} LIMIT ${SNAPSHOT_BATCH})`;
      total += count;
      if (count < SNAPSHOT_BATCH) return total;
      await pause();
    }
  }

  /**
   * Matches that kicked off before `cutoff` with no bet on any of their
   * picks, a batch at a time. Deleting a match takes its markets, prices,
   * price history and Owner prices with it.
   */
  private async deleteUnusedEvents(cutoff: Date): Promise<number> {
    const unused = {
      startsAt: { lt: cutoff },
      markets: { none: { selections: { some: { OR: [{ bets: { some: {} } }, { legs: { some: {} } }] } } } },
    } satisfies Prisma.EventWhereInput;
    let total = 0;
    for (;;) {
      const batch = await this.prisma.event.findMany({ where: unused, select: { id: true }, take: EVENT_BATCH });
      if (batch.length === 0) return total;
      // The same test again on delete: a bet placed since the read keeps its match.
      const { count } = await this.prisma.event.deleteMany({ where: { id: { in: batch.map((event) => event.id) }, ...unused } });
      total += count;
      if (batch.length < EVENT_BATCH) return total;
      await pause();
    }
  }

  /** One clean-up pass. Returns how many rows went, per kind. */
  async run(now = new Date()) {
    if (this.running) return null;
    this.running = true;
    try {
      const keep = retentionDays();
      const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

      const oddsHistory = { count: await this.deleteOldSnapshots(before(keep.oddsHistory)) };
      const unusedEvents = { count: await this.deleteUnusedEvents(before(keep.unusedEvents)) };
      const notifications = await this.prisma.notification.deleteMany({
        where: {
          OR: [
            { createdAt: { lt: before(keep.notifications) } },
            { createdAt: { lt: before(keep.readNotifications) }, OR: [{ readAt: { not: null } }, { archivedAt: { not: null } }] },
          ],
        },
      });
      const loginHistory = await this.prisma.loginHistory.deleteMany({ where: { lastSeenAt: { lt: before(keep.loginHistory) } } });
      const idempotencyKeys = await this.prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: before(keep.idempotencyKeys) } } });

      const removed = {
        oddsHistory: oddsHistory.count,
        unusedEvents: unusedEvents.count,
        notifications: notifications.count,
        loginHistory: loginHistory.count,
        idempotencyKeys: idempotencyKeys.count,
      };
      if (Object.values(removed).some((count) => count > 0)) this.logger.log(`Cleaned up old data: ${JSON.stringify(removed)}`);
      return removed;
    } catch (error) {
      this.logger.warn(`Clean-up failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
