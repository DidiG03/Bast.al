import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { RequestIntegrityGuard } from "../security/request-integrity.guard";
import { BettingLimitsDto } from "./commissions.dto";
import { BettingLimitsService } from "./betting-limits.service";
import { PlayerActivityService } from "./player-activity.service";

@ApiTags("players")
@Controller("players")
export class PlayersController {
  constructor(
    private readonly activity: PlayerActivityService,
    private readonly limits: BettingLimitsService,
  ) {}

  @Get(":id/activity")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  get(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.activity.activity(actor, id);
  }

  @Get(":id/limits")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  getLimits(@CurrentActor() actor: Actor, @Param("id") id: string) {
    return this.limits.get(actor, id);
  }

  @Post(":id/limits")
  @ApiBearerAuth()
  @UseGuards(RequestIntegrityGuard, AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  setLimits(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() dto: BettingLimitsDto) {
    return this.limits.set(actor, id, dto);
  }
}
