import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { AuthGuard, AuthenticatedRequest } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Idempotent } from "../idempotency/idempotency.interceptor";
import { clientIp } from "../security/client-ip";
import { CommissionPayoutsService } from "./commission-payouts.service";
import { CommissionDailyDto, CommissionHistoryDto, CommissionPayoutDto, CommissionPeriodDto, PayoutPeriodDto, TeamCommissionQueryDto } from "./commissions.dto";
import { CommissionsService } from "./commissions.service";

@ApiTags("commissions")
@Controller("commissions")
export class CommissionsController {
  constructor(
    private readonly commissions: CommissionsService,
    private readonly payouts: CommissionPayoutsService,
  ) {}

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

  @Get("daily")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  daily(@CurrentActor() actor: Actor, @Query() query: CommissionDailyDto) {
    return this.commissions.daily(actor, query.days ?? 7);
  }

  @Get("mine")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.MANAGER)
  mine(@CurrentActor() actor: Actor, @Query() query: CommissionPeriodDto) {
    return this.commissions.mine(actor, query.from, query.to);
  }

  @Get("mine/history")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.MANAGER)
  history(@CurrentActor() actor: Actor, @Query() query: CommissionHistoryDto) {
    return this.commissions.history(actor, query.weeks ?? 8);
  }

  /** Commission already paid for periods overlapping [from, to). */
  @Get("payouts")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  listPayouts(@CurrentActor() actor: Actor, @Query() query: PayoutPeriodDto) {
    return this.payouts.list(actor, query.from, query.to);
  }

  /** Super Admin collects an Owner's commission, or an Owner pays a Manager's, for a finished period. */
  @Post("payouts")
  @ApiBearerAuth()
  @UseGuards(AuthGuard, MfaGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  @Idempotent()
  pay(@CurrentActor() actor: Actor, @Body() body: CommissionPayoutDto, @Req() req: AuthenticatedRequest) {
    return this.payouts.pay(actor, body.userId, body.from, body.to, body.label, clientIp(req));
  }
}
