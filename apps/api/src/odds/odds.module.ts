import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security.module";
import { OddsSyncService } from "./odds-sync.service";
import { OddsController } from "./odds.controller";
import { OddsService } from "./odds.service";

@Module({
  imports: [AuthModule, SecurityModule, AuditModule],
  controllers: [OddsController],
  providers: [OddsService, OddsSyncService],
  exports: [OddsService],
})
export class OddsModule {}
