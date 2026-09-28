import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { RiskCapDto, RiskQueryDto } from "./bets.dto";
import { RiskService } from "./risk.service";

@ApiTags("risk")
@ApiBearerAuth()
@UseGuards(AuthGuard, MfaGuard, RolesGuard)
@Controller("risk")
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  /** A team's open payouts per match and outcome, worst first. */
  @Get()
  @Roles(Role.OWNER, Role.SUPER_ADMIN)
  view(@CurrentActor() actor: Actor, @Query() query: RiskQueryDto) {
    return this.risk.view(actor, query.ownerId);
  }

  /** The most the team may pay out on any one outcome. */
  @Put("cap")
  @Roles(Role.OWNER, Role.SUPER_ADMIN)
  setCap(@CurrentActor() actor: Actor, @Body() body: RiskCapDto, @Query() query: RiskQueryDto) {
    return this.risk.setCap(actor, body.maxOutcomePayout ?? null, query.ownerId);
  }
}
