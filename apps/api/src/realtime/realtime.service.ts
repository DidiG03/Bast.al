import {
  Injectable,
  Logger,
  MessageEvent,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Redis from "ioredis";
import { Observable, Subscriber } from "rxjs";
import { Role } from "@prisma/client";
import type { Actor } from "../auth/permissions";
import { PrismaService } from "../prisma.service";

/** Everything the browser can be told live. Account events go to that account; a price change goes to every open stream. */
export type RealtimeEvent =
  | { type: "notification.created"; notification: unknown }
  /** Read/archive/delete happened elsewhere (another tab or device): refetch the list. */
  | { type: "notifications.changed" }
  | { type: "balance.changed"; balance: number; balanceLimit: number }
  /** A Player's bets were placed, settled or voided: refetch them. */
  | { type: "bets.changed" }
  /** Live prices were just saved. Every open bet board refetches them; the rest of the dashboard does not re-render. */
  | { type: "odds.changed" }
  /** Live prices just saved, already priced for the team receiving them: only what changed since the last one (see OddsService.pushLive). */
  | { type: "odds.live"; at: string; events: LiveDelta[] };

/**
 * What changed on one live match. The header (score, minute, whether it
 * takes bets, what's paused) comes when any of it changed; `markets` are [market id,
 * suspended, stale] and `prices` [selection id, price, suspended] pairs that changed.
 */
export type LiveDelta = {
  id: string;
  header?: {
    status: string;
    live: boolean;
    elapsed: number | null;
    elapsedAt: string | null;
    period: string | null;
    homeScore: number | null;
    awayScore: number | null;
    bettable: boolean;
    livePause: string | null;
    allMarketsSuspended: boolean;
    marketPause: { reason: string; count: number; markets: string[]; ids: string[]; until: string; exact: boolean } | null;
  };
  /**
   * [market id, suspended, stale, our pause reason or null, the reason of a pause of ours that just ended while the
   * bookmaker still holds the market (pauseJustEnded) or null]. Our pause reason is the only source of the "Paused" label.
   */
  markets?: Array<[string, boolean, boolean, string | null, string | null]>;
  prices?: Array<[string, number, boolean]>;
};

/** Streams that get one team's live prices: its Players. */
export const teamTopic = (ownerId: string | null) => `team:${ownerId ?? "none"}`;
/** Streams of everyone else (Super Admin, Owners, Managers): they see feed prices, so they're told to fetch. */
export const STAFF_TOPIC = "staff";

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
  /** The same streams by topic (see teamTopic, STAFF_TOPIC). */
  private readonly topics = new Map<string, Set<Subscriber<MessageEvent>>>();
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

  /** Live events for one account, and for the topics it's on. Completes when the client disconnects. */
  stream(userId: string, topics: string[] = []): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const keys: Array<[Map<string, Set<Subscriber<MessageEvent>>>, string]> = [[this.listeners, userId], ...topics.map((topic): [Map<string, Set<Subscriber<MessageEvent>>>, string] => [this.topics, topic])];
      for (const [map, key] of keys) {
        let subscribers = map.get(key);
        if (!subscribers) {
          subscribers = new Set();
          map.set(key, subscribers);
        }
        subscribers.add(subscriber);
      }
      return () => {
        for (const [map, key] of keys) {
          const subscribers = map.get(key);
          if (!subscribers) continue;
          subscribers.delete(subscriber);
          if (subscribers.size === 0) map.delete(key);
        }
      };
    });
  }

  /**
   * The topics an account's stream is on: a Player gets their team's live
   * prices (their Owner's, through their Manager if they have one); everyone
   * else is staff.
   */
  async topicsFor(actor: Actor): Promise<string[]> {
    if (actor.role !== Role.PLAYER) return [STAFF_TOPIC];
    const parent = actor.parentId ? await this.prisma.user.findUnique({ where: { id: actor.parentId }, select: { id: true, role: true, parentId: true } }) : null;
    const ownerId = parent?.role === Role.OWNER ? parent.id : parent?.role === Role.MANAGER ? parent.parentId : null;
    return [teamTopic(ownerId)];
  }

  /** Tells every stream on a topic. A side effect: this never throws. */
  async publishTopic(topic: string, event: RealtimeEvent) {
    await this.publish(`topic:${topic}`, event);
  }

  /** Open streams on this instance: someone has the site open. */
  listenerCount(): number {
    let count = 0;
    for (const subscribers of this.listeners.values()) count += subscribers.size;
    return count;
  }

  /** Tells every open stream, whichever account it belongs to. A side effect: this never throws. */
  async publishAll(event: RealtimeEvent) {
    await this.publish("*", event);
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
    const message: MessageEvent = { type: event.type, data: event };
    if (userId.startsWith("topic:")) {
      this.topics.get(userId.slice("topic:".length))?.forEach((subscriber) => subscriber.next(message));
      return;
    }
    if (userId === "*") {
      for (const subscribers of this.listeners.values()) subscribers.forEach((subscriber) => subscriber.next(message));
      return;
    }
    const subscribers = this.listeners.get(userId);
    if (!subscribers) return;
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
