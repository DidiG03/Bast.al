import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, BadRequestException } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { BetStatus, Role } from "@prisma/client";
import { AuthGuard, AuthenticatedRequest } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Idempotent } from "../idempotency/idempotency.interceptor";
import { clientIp } from "../security/client-ip";
import { AdminBetsQueryDto, MyBetsQueryDto, PlaceBetsDto, ResultDto, VoidDto } from "./bets.dto";
import { BetsService } from "./bets.service";
import { SettlementService } from "./settlement.service";

@ApiTags("bets")
@ApiBearerAuth()
@UseGuards(AuthGuard, MfaGuard, RolesGuard)
@Controller("bets")
export class BetsController {
  constructor(
    private readonly bets: BetsService,
    private readonly settlement: SettlementService,
  ) {}

  /** Places every bet on the slip as a single, or none of them. */
  @Post()
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Idempotent()
  place(@CurrentActor() actor: Actor, @Body() body: PlaceBetsDto, @Req() req: AuthenticatedRequest) {
    return this.bets.place(actor, body, clientIp(req));
  }

  @Get("mine")
  @Roles(Role.PLAYER)
  mine(@CurrentActor() actor: Actor, @Query() query: MyBetsQueryDto) {
    return this.bets.mine(actor, query.status, query.before);
  }

  @Get("slip")
  @Roles(Role.PLAYER)
  slip(@CurrentActor() actor: Actor) {
    return this.bets.slipInfo(actor);
  }

  @Get("admin")
  @Roles(Role.SUPER_ADMIN)
  adminBets(@Query() query: AdminBetsQueryDto) {
    return this.settlement.adminBets({ status: query.status as BetStatus | undefined, player: query.player, eventId: query.eventId });
  }

  @Get("admin/events")
  @Roles(Role.SUPER_ADMIN)
  adminEvents() {
    return this.settlement.adminEvents();
  }

  @Post("admin/events/:id/result")
  @Roles(Role.SUPER_ADMIN)
  @Idempotent()
  correctResult(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: ResultDto) {
    const half = body.halfHome !== undefined && body.halfAway !== undefined ? { home: body.halfHome, away: body.halfAway } : null;
    const counts = [body.cornersHome, body.cornersAway, body.cardsHome, body.cardsAway];
    if (counts.some((n) => n !== undefined) && counts.some((n) => n === undefined)) throw new BadRequestException("Enter corners and cards for both teams, or leave all four empty");
    const stats =
      body.cornersHome !== undefined && body.cornersAway !== undefined && body.cardsHome !== undefined && body.cardsAway !== undefined
        ? { cornersHome: body.cornersHome, cornersAway: body.cornersAway, cardsHome: body.cardsHome, cardsAway: body.cardsAway }
        : null;
    return this.settlement.correctResult(actor, id, body.home, body.away, half, stats);
  }

  @Post("admin/events/:id/void")
  @Roles(Role.SUPER_ADMIN)
  @Idempotent()
  voidEvent(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: VoidDto) {
    return this.settlement.voidEvent(actor, id, body.reason);
  }

  @Post("admin/:id/void")
  @Roles(Role.SUPER_ADMIN)
  @Idempotent()
  voidBet(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: VoidDto) {
    return this.settlement.voidBet(actor, id, body.reason);
  }
}
