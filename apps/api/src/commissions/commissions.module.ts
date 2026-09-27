import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SecurityModule } from "../security/security.module";
import { UsersModule } from "../users/users.module";
import { CommissionsController } from "./commissions.controller";
import { CommissionsService } from "./commissions.service";
import { PlayerActivityService } from "./player-activity.service";
import { PlayersController } from "./players.controller";

@Module({
  imports: [AuthModule, SecurityModule, UsersModule],
  controllers: [CommissionsController, PlayersController],
  providers: [CommissionsService, PlayerActivityService],
})
export class CommissionsModule {}
