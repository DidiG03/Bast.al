import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentActor } from "../auth/current-actor.decorator";
import { MfaGuard } from "../auth/mfa.guard";
import type { Actor } from "../auth/permissions";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { Idempotent } from "../idempotency/idempotency.interceptor";
import { SIDES as BACCARAT_SIDES } from "./baccarat";
import { GUESSES } from "./hilo";
import { HouseGamesService } from "./house-games.service";
import { LEVELS } from "./tower";
import { RISKS } from "./wheel";

class StakeDto {
  @ApiProperty({ description: "The stake, in ALL" })
  @IsNumber()
  bet!: number;
}

class WheelDto extends StakeDto {
  @ApiProperty({ enum: RISKS })
  @IsIn([...RISKS])
  risk!: string;
}

class BaccaratDto extends StakeDto {
  @ApiProperty({ enum: BACCARAT_SIDES })
  @IsIn([...BACCARAT_SIDES])
  side!: string;
}

class HiloGuessDto {
  @ApiProperty({ enum: GUESSES })
  @IsIn([...GUESSES])
  guess!: string;
}

class TowerStartDto extends StakeDto {
  @ApiProperty({ enum: LEVELS })
  @IsIn([...LEVELS])
  level!: string;
}

class TowerClimbDto {
  @ApiProperty({ description: "The door to open on the next floor, from 0 on the left" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3)
  door!: number;
}

class CrashStartDto extends StakeDto {
  @ApiProperty({ required: false, description: "Cash out by itself at this multiplier (1.01 to 5000), or leave it out" })
  @IsOptional()
  @IsNumber()
  auto?: number | null;
}

/**
 * Money Wheel, Baccarat, Hi-Lo, Tower, Crash and Candy Cascade. Every move that touches the
 * balance takes an Idempotency-Key, so a repeated request gets the first answer back.
 */
@ApiTags("casino")
@ApiBearerAuth()
@UseGuards(AuthGuard, MfaGuard, RolesGuard)
@Controller("casino")
export class HouseGamesController {
  constructor(private readonly games: HouseGamesService) {}

  @Get("wheel")
  @Roles(Role.PLAYER)
  wheelState(@CurrentActor() actor: Actor) {
    return this.games.wheelState(actor);
  }

  @Post("wheel/spin")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  wheelSpin(@CurrentActor() actor: Actor, @Body() body: WheelDto) {
    return this.games.wheelSpin(actor, body.bet, body.risk);
  }

  @Get("candy")
  @Roles(Role.PLAYER)
  candyState(@CurrentActor() actor: Actor) {
    return this.games.candyState(actor);
  }

  @Post("candy/spin")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  candySpin(@CurrentActor() actor: Actor, @Body() body: StakeDto) {
    return this.games.candySpin(actor, body.bet);
  }

  @Get("baccarat")
  @Roles(Role.PLAYER)
  baccaratState(@CurrentActor() actor: Actor) {
    return this.games.baccaratState(actor);
  }

  @Post("baccarat/deal")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  baccaratDeal(@CurrentActor() actor: Actor, @Body() body: BaccaratDto) {
    return this.games.baccaratDeal(actor, body.bet, body.side);
  }

  @Get("hilo")
  @Roles(Role.PLAYER)
  hiloState(@CurrentActor() actor: Actor) {
    return this.games.hiloState(actor);
  }

  @Post("hilo/start")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  hiloStart(@CurrentActor() actor: Actor, @Body() body: StakeDto) {
    return this.games.hiloStart(actor, body.bet);
  }

  @Post("hilo/guess")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @Idempotent()
  hiloGuess(@CurrentActor() actor: Actor, @Body() body: HiloGuessDto) {
    return this.games.hiloGuess(actor, body.guess);
  }

  @Post("hilo/cashout")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  hiloCashOut(@CurrentActor() actor: Actor) {
    return this.games.hiloCashOut(actor);
  }

  @Get("tower")
  @Roles(Role.PLAYER)
  towerState(@CurrentActor() actor: Actor) {
    return this.games.towerState(actor);
  }

  @Post("tower/start")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  towerStart(@CurrentActor() actor: Actor, @Body() body: TowerStartDto) {
    return this.games.towerStart(actor, body.bet, body.level);
  }

  @Post("tower/climb")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @Idempotent()
  towerClimb(@CurrentActor() actor: Actor, @Body() body: TowerClimbDto) {
    return this.games.towerClimb(actor, body.door);
  }

  @Post("tower/cashout")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  towerCashOut(@CurrentActor() actor: Actor) {
    return this.games.towerCashOut(actor);
  }

  @Get("crash")
  @Roles(Role.PLAYER)
  crashState(@CurrentActor() actor: Actor) {
    return this.games.crashState(actor);
  }

  @Post("crash/start")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  crashStart(@CurrentActor() actor: Actor, @Body() body: CrashStartDto) {
    return this.games.crashStart(actor, body.bet, body.auto ?? null);
  }

  /** Where the round stands: asked about twice a second while it climbs, so a crash shows straight away. */
  @Post("crash/check")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  crashCheck(@CurrentActor() actor: Actor) {
    return this.games.crashCheck(actor);
  }

  @Post("crash/cashout")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  crashCashOut(@CurrentActor() actor: Actor) {
    return this.games.crashCashOut(actor);
  }
}
