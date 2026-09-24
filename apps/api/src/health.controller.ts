import { Controller, Get } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PrismaService } from "./prisma.service";
import { QueueService } from "./queue.service";

@ApiTags("system")
@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly queue: QueueService) {}
  @Get() async check() { await this.prisma.$queryRaw`SELECT 1`; const redis = await this.queue.ping(); return { status: "ok", database: "up", redis, timestamp: new Date().toISOString() }; }
}

@ApiTags("system")
@Controller()
export class RootController {
  @Get()
  info() {
    return {
      name: "Bast.al API",
      status: "ok",
      health: "/api/health",
      docs: process.env.NODE_ENV === "production" ? undefined : "/docs",
    };
  }
}
