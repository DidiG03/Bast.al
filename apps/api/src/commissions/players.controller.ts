import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { PlayerActivityService } from "./player-activity.service";

@ApiTags("players")
@Controller("players")
export class PlayersController {
  constructor(private readonly activity: PlayerActivityService) {}

  @Get(":id/activity")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  get(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.activity.activity(actor, id);
  }
}
