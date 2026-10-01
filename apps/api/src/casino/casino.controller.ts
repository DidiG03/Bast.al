import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength } from "class-validator";
import { AuthGuard, AuthenticatedRequest } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Idempotent } from "../idempotency/idempotency.interceptor";
import { clientIp } from "../security/client-ip";
import { RequestIntegrityGuard } from "../security/request-integrity.guard";
import { CasinoService } from "./casino.service";
import { BETS } from "./game";

class SpinDto {
  @ApiProperty({ enum: BETS, description: "What the spin costs, in dollars. Ignored while the Player has free spins left from the old game." })
  @IsNumber()
  @IsIn([...BETS])
  bet!: number;
}

class GambleDto {
  @ApiProperty({ enum: ["RED", "BLACK"], description: "The colour the Player thinks the card will be" })
  @IsIn(["RED", "BLACK"])
  pick!: "RED" | "BLACK";
}

class CasinoOpenDto {
  @ApiProperty()
  @IsBoolean()
  open!: boolean;

  @ApiProperty({ required: false, description: "An Owner's team; leave out for the whole site (Super Admin)" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string;
}

class CasinoPeriodDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

@ApiTags("casino")
@ApiBearerAuth()
@UseGuards(AuthGuard, MfaGuard, RolesGuard)
@Controller("casino")
export class CasinoController {
  constructor(private readonly casino: CasinoService) {}

  /** The Player's Casino: can they play, the rules, free spins, recent spins. */
  @Get()
  @Roles(Role.PLAYER)
  state(@CurrentActor() actor: Actor) {
    return this.casino.state(actor);
  }

  /** One spin. A repeated request with the same Idempotency-Key gets the first spin's answer back. */
  @Post("spin")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @Idempotent()
  spin(@CurrentActor() actor: Actor, @Body() body: SpinDto, @Req() req: AuthenticatedRequest) {
    return this.casino.spin(actor, body.bet, clientIp(req));
  }

  /** Double or nothing on the last win. Like a spin, a repeated request gets the first answer back. */
  @Post("gamble")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 90, ttl: 60_000 } })
  @Idempotent()
  gamble(@CurrentActor() actor: Actor, @Body() body: GambleDto, @Req() req: AuthenticatedRequest) {
    return this.casino.gamble(actor, body.pick, clientIp(req));
  }

  /** Takes the win and ends double or nothing. */
  @Post("collect")
  @Roles(Role.PLAYER)
  collect(@CurrentActor() actor: Actor) {
    return this.casino.collect(actor);
  }

  /** Whether the Casino is open, and how it did in a period, per Player. */
  @Get("admin")
  @Roles(Role.SUPER_ADMIN, Role.OWNER, Role.MANAGER)
  admin(@CurrentActor() actor: Actor, @Query() query: CasinoPeriodDto) {
    return this.casino.admin(actor, query.from, query.to);
  }

  /** Opens or closes the Casino for the site (Super Admin) or one team (Super Admin, or that team's Owner). */
  @Post("admin/open")
  @UseGuards(RequestIntegrityGuard)
  @Roles(Role.SUPER_ADMIN, Role.OWNER)
  setOpen(@CurrentActor() actor: Actor, @Body() body: CasinoOpenDto, @Req() req: AuthenticatedRequest) {
    return this.casino.setOpen(actor, body.open, body.ownerId, clientIp(req));
  }
}
