import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { isVisitorAddress } from "./client-ip";

type CounterEntry = { count: number; resetAt: number; bannedUntil?: number };

/**
 * IP / principal reputation with Redis when available, in-memory fallback otherwise.
 * Used for auth lockouts, honeypot bans, and nonce replay protection.
 *
 * Failures and bans only ever apply to a visitor's own address. A shared one
 * (a hosting proxy, our web server, a private network) is never counted or
 * blocked, since that would lock out everyone who comes through it.
 */
@Injectable()
export class ThreatIntelService implements OnModuleDestroy {
  private readonly logger = new Logger(ThreatIntelService.name);
  private readonly memory = new Map<string, CounterEntry>();
  private redis: Redis | null = null;
  private readonly failLimit: number;
  private readonly failWindowMs: number;
  private readonly banMs: number;

  constructor(private readonly config: ConfigService) {
    this.failLimit = Number(this.config.get("SECURITY_FAIL_LIMIT") ?? 8);
    this.failWindowMs = Number(this.config.get("SECURITY_FAIL_WINDOW_MS") ?? 15 * 60_000);
    this.banMs = Number(this.config.get("SECURITY_BAN_MS") ?? 60 * 60_000);

    const redisUrl = this.config.get<string>("REDIS_URL");
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          enableReadyCheck: true,
          lazyConnect: true,
        });
        void this.redis.connect().catch((err) => {
          this.logger.warn(`Redis unavailable for threat intel, using memory: ${String(err)}`);
          this.redis = null;
        });
      } catch {
        this.redis = null;
      }
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }

  async isBlocked(key: string): Promise<boolean> {
    if (!isVisitorAddress(key)) return false;
    if (this.redis) {
      const bannedUntil = await this.redis.get(`ban:${key}`);
      if (bannedUntil && Number(bannedUntil) > Date.now()) return true;
      return false;
    }
    this.prune();
    const entry = this.memory.get(key);
    return Boolean(entry?.bannedUntil && entry.bannedUntil > Date.now());
  }

  async recordFailure(key: string): Promise<{ banned: boolean; failures: number }> {
    if (!isVisitorAddress(key)) return { banned: false, failures: 0 };
    if (this.redis) {
      const failKey = `fail:${key}`;
      const count = await this.redis.incr(failKey);
      if (count === 1) {
        await this.redis.pexpire(failKey, this.failWindowMs);
      }
      if (count >= this.failLimit) {
        await this.redis.set(`ban:${key}`, String(Date.now() + this.banMs), "PX", this.banMs);
        await this.redis.del(failKey);
        return { banned: true, failures: count };
      }
      return { banned: false, failures: count };
    }

    this.prune();
    const now = Date.now();
    const existing = this.memory.get(key);
    const entry: CounterEntry =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + this.failWindowMs };
    entry.count += 1;
    if (entry.count >= this.failLimit) {
      entry.bannedUntil = now + this.banMs;
      entry.count = 0;
      this.memory.set(key, entry);
      return { banned: true, failures: this.failLimit };
    }
    this.memory.set(key, entry);
    return { banned: false, failures: entry.count };
  }

  async clearFailures(key: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(`fail:${key}`, `ban:${key}`);
      return;
    }
    this.memory.delete(key);
  }

  async ban(key: string, reason: string): Promise<void> {
    if (!isVisitorAddress(key)) {
      this.logger.warn(`Not banning ${key} (${reason}): it's a shared address, not one visitor's`);
      return;
    }
    this.logger.warn(`Banning ${key}: ${reason}`);
    if (this.redis) {
      await this.redis.set(`ban:${key}`, String(Date.now() + this.banMs), "PX", this.banMs);
      return;
    }
    this.memory.set(key, {
      count: this.failLimit,
      resetAt: Date.now() + this.failWindowMs,
      bannedUntil: Date.now() + this.banMs,
    });
  }

  /**
   * True the first time `key` is seen within `ttlMs`, false after that until
   * it expires. For things worth recording once in a while rather than on
   * every request.
   */
  async firstInWindow(key: string, ttlMs: number): Promise<boolean> {
    if (this.redis) {
      const ok = await this.redis.set(`once:${key}`, "1", "PX", ttlMs, "NX").catch(() => "OK");
      return ok === "OK";
    }
    this.prune();
    const memoryKey = `once:${key}`;
    if (this.memory.has(memoryKey)) return false;
    this.memory.set(memoryKey, { count: 1, resetAt: Date.now() + ttlMs });
    return true;
  }

  /** Returns false if nonce was already seen (replay). */
  async consumeNonce(nonce: string, ttlMs = 120_000): Promise<boolean> {
    if (!nonce || nonce.length < 16 || nonce.length > 128) return false;
    if (this.redis) {
      const ok = await this.redis.set(`nonce:${nonce}`, "1", "PX", ttlMs, "NX");
      return ok === "OK";
    }
    this.prune();
    const key = `nonce:${nonce}`;
    if (this.memory.has(key)) return false;
    this.memory.set(key, { count: 1, resetAt: Date.now() + ttlMs });
    return true;
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (entry.resetAt <= now && (!entry.bannedUntil || entry.bannedUntil <= now)) {
        this.memory.delete(key);
      }
    }
  }
}
