import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CommissionPeriodDto, TeamCommissionQueryDto } from "./commissions.dto";
import { CommissionsService } from "./commissions.service";

@ApiTags("commissions")
@Controller("commissions")
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Get("owners")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  owners(@CurrentActor() actor: Actor, @Query() query: CommissionPeriodDto) {
    return this.commissions.owners(actor, query.from, query.to);
  }

  @Get("team")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  team(@CurrentActor() actor: Actor, @Query() query: TeamCommissionQueryDto) {
    return this.commissions.team(actor, query.ownerId, query.from, query.to);
  }

  @Get("mine")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.MANAGER)
  mine(@CurrentActor() actor: Actor, @Query() query: CommissionPeriodDto) {
    return this.commissions.mine(actor, query.from, query.to);
  }
}
