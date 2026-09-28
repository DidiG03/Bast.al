import {
  Injectable,
  Logger,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import { Observable, Subscriber } from "rxjs";
import { PrismaService } from "../prisma.service";

/** Everything the browser can be told live. Each event only ever goes to the account it is about. */
export type RealtimeEvent =
  | { type: "notification.created"; notification: unknown }
  /** Read/archive/delete happened elsewhere (another tab or device): refetch the list. */
  | { type: "notifications.changed" }
  | { type: "balance.changed"; balance: number; balanceLimit: number }
  /** A Player's bets were placed, settled or voided: refetch them. */
  | { type: "bets.changed" };

const CHANNEL = "bastal:realtime";

/**
 * Fans account events out to every open browser stream. Events go through
 * Redis pub/sub so a change made on one API instance reaches a stream held by
 * another. If Redis is unavailable the event is delivered to this instance's
 * streams only; clients refetch on every reconnect, so nothing stays stale.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly listeners = new Map<string, Set<Subscriber<MessageEvent>>>();
  private publisher?: Redis;
  private subscriber?: Redis;
  private lastErrorLog = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.publisher = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.subscriber = new Redis(url);
    this.publisher.on("error", (error) => this.logError(error));
    this.subscriber.on("error", (error) => this.logError(error));
    this.subscriber.on("message", (_channel, raw: string) => {
      try {
        const { userId, event } = JSON.parse(raw) as {
          userId: string;
          event: RealtimeEvent;
        };
        this.deliver(userId, event);
      } catch (error) {
        this.logError(error);
      }
    });
    this.subscriber.subscribe(CHANNEL).catch((error) => this.logError(error));
  }

  async onModuleDestroy() {
    for (const subscribers of this.listeners.values())
      subscribers.forEach((subscriber) => subscriber.complete());
    this.listeners.clear();
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  /** Live events for one account. Completes when the client disconnects. */
  stream(userId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let subscribers = this.listeners.get(userId);
      if (!subscribers) {
        subscribers = new Set();
        this.listeners.set(userId, subscribers);
      }
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
        if (
          subscribers.size === 0 &&
          this.listeners.get(userId) === subscribers
        )
          this.listeners.delete(userId);
      };
    });
  }

  /** A side effect, never the point of the call: this never throws. */
  async publish(userId: string, event: RealtimeEvent) {
    try {
      if (this.publisher?.status === "ready") {
        await this.publisher.publish(
          CHANNEL,
          JSON.stringify({ userId, event }),
        );
        return;
      }
    } catch (error) {
      this.logError(error);
    }
    this.deliver(userId, event);
  }

  /** Push the current balance of each account. Call after the transaction that moved it has committed. */
  async publishBalances(userIds: Array<string | null | undefined>) {
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    try {
      const rows = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, balance: true, balanceLimit: true },
      });
      await Promise.all(
        rows.map((row) =>
          this.publish(row.id, {
            type: "balance.changed",
            balance: Number(row.balance),
            balanceLimit: Number(row.balanceLimit),
          }),
        ),
      );
    } catch (error) {
      this.logError(error);
    }
  }

  private deliver(userId: string, event: RealtimeEvent) {
    const subscribers = this.listeners.get(userId);
    if (!subscribers) return;
    const message: MessageEvent = { type: event.type, data: event };
    subscribers.forEach((subscriber) => subscriber.next(message));
  }

  /** Redis retries every second while down; log at most once a minute. */
  private logError(error: unknown) {
    const now = Date.now();
    if (now - this.lastErrorLog < 60_000) return;
    this.lastErrorLog = now;
    this.logger.warn(`Realtime delivery degraded: ${String(error)}`);
  }
}
