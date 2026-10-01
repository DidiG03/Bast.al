import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security.module";
import { UsersModule } from "../users/users.module";
import { CommissionsController } from "./commissions.controller";
import { CommissionPayoutsService } from "./commission-payouts.service";
import { CommissionsService } from "./commissions.service";
import { BettingLimitsService } from "./betting-limits.service";
import { PlayerActivityService } from "./player-activity.service";
import { PlayersController } from "./players.controller";

@Module({
  imports: [AuthModule, SecurityModule, UsersModule],
  controllers: [CommissionsController, PlayersController],
  providers: [CommissionsService, CommissionPayoutsService, PlayerActivityService, BettingLimitsService],
  exports: [BettingLimitsService, CommissionsService],
})
export class CommissionsModule {}
