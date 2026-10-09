import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Database connections the API keeps open, unless DATABASE_URL says
 * otherwise (`?connection_limit=`). Prisma's own default is two per CPU plus
 * one, five on a two-CPU host: every bet slip and casino round holds one
 * for its transaction, so a busy evening queued behind those few. Postgres
 * allows 100 by default; DATABASE_POOL_SIZE changes this one.
 */
const DEFAULT_POOL_SIZE = 20;

/** DATABASE_URL with the pool size added, when it doesn't set one itself. */
export function withPoolSize(url: string | undefined, size = Number(process.env.DATABASE_POOL_SIZE) || DEFAULT_POOL_SIZE): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("connection_limit")) return url;
    parsed.searchParams.set("connection_limit", String(size));
    return parsed.toString();
  } catch {
    // Not a URL Node can read: Prisma reports it as it always has.
    return url;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = withPoolSize(process.env.DATABASE_URL);
    // Without DATABASE_URL, Prisma's own "Environment variable not found" error still shows.
    super(url ? { datasources: { db: { url } } } : undefined);
    if (url) new Logger(PrismaService.name).log(`Database pool: ${new URL(url).searchParams.get("connection_limit")} connections`);
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
