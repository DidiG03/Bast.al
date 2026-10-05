import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security.module";
import { GreyhoundSyncService } from "./greyhound-sync.service";
import { BasketballSyncService } from "./basketball-sync.service";
import { NflSyncService } from "./nfl-sync.service";
import { MmaSyncService } from "./mma-sync.service";
import { OddsSyncService } from "./odds-sync.service";
import { OddsController } from "./odds.controller";
import { OddsService } from "./odds.service";

@Module({
  imports: [AuthModule, SecurityModule, AuditModule],
  controllers: [OddsController],
  providers: [OddsService, OddsSyncService, GreyhoundSyncService, MmaSyncService, BasketballSyncService, NflSyncService],
  exports: [OddsService, OddsSyncService, GreyhoundSyncService, MmaSyncService, BasketballSyncService, NflSyncService],
})
export class OddsModule {}
