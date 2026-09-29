import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { CryptoModule } from "./crypto/crypto.module";
import { EventsController } from "./events.controller";
import { HealthController, RootController } from "./health.controller";
import { PrismaModule } from "./prisma.module";
import { QueueService } from "./queue.service";
import { SecurityModule } from "./security/security.module";
import { UsersModule } from "./users/users.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { CommissionsModule } from "./commissions/commissions.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { OddsModule } from "./odds/odds.module";
import { BetsModule } from "./bets/bets.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60_000,
        limit: 100,
      },
      {
        name: "strict",
        ttl: 60_000,
        limit: 20,
      },
    ]),
    PrismaModule,
    CryptoModule,
    SecurityModule,
    AuthModule,
    RealtimeModule,
    UsersModule,
    NotificationsModule,
    WebhooksModule,
    CommissionsModule,
    OddsModule,
    BetsModule,
    MaintenanceModule,
  ],
  controllers: [HealthController, RootController, EventsController],
  providers: [QueueService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
