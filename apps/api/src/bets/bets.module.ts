import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { CommissionsModule } from "../commissions/commissions.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OddsModule } from "../odds/odds.module";
import { SecurityModule } from "../security/security.module";
import { UsersModule } from "../users/users.module";
import { BetsController } from "./bets.controller";
import { BetsService } from "./bets.service";
import { RiskController } from "./risk.controller";
import { RiskService } from "./risk.service";
import { SettlementService } from "./settlement.service";

@Module({
  imports: [AuthModule, SecurityModule, AuditModule, UsersModule, NotificationsModule, OddsModule, CommissionsModule],
  controllers: [BetsController, RiskController],
  providers: [BetsService, SettlementService, RiskService],
})
export class BetsModule {}
