import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queue = new Queue("event-sync", { connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" } });
  async ping() { await this.queue.waitUntilReady(); return "up"; }
  async onModuleDestroy() { await this.queue.close(); }
}
