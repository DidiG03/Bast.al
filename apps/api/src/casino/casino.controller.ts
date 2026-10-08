import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
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
import { MAX_SPOTS } from "./roulette";
import { RouletteService } from "./roulette.service";
import { BlackjackService } from "./blackjack.service";
import { BookService } from "./book.service";
import { MinesService } from "./mines.service";
import { PenaltyService } from "./penalty.service";
import { PlinkoService } from "./plinko.service";
import { BETS as BOOK_BETS } from "./book";
import { MINE_COUNTS, TILES } from "./mines";
import { DIRECTIONS } from "./penalty";
import { BETS as PLINKO_BETS, RISKS as PLINKO_RISKS, ROWS as PLINKO_ROWS } from "./plinko";

class SpinDto {
  @ApiProperty({ enum: BETS, description: "What the spin costs, in dollars. Ignored while the Player has free spins left from the old game." })
  @IsNumber()
  @IsIn([...BETS])
  bet!: number;
}

class BookSpinDto {
  @ApiProperty({ enum: BOOK_BETS, description: "What the spin costs, in dollars. Ignored during free spins, which play at the bet that started them." })
  @IsNumber()
  @IsIn([...BOOK_BETS])
  bet!: number;
}

class GambleDto {
  @ApiProperty({ enum: ["RED", "BLACK"], description: "The colour the Player thinks the card will be" })
  @IsIn(["RED", "BLACK"])
  pick!: "RED" | "BLACK";
}

class RouletteBetDto {
  @ApiProperty({ description: 'A spot on the table: numbers for an inside bet ("17", "0-00", "1-2-4-5"), or a name ("RED", "COL1", "1ST12", "1-18")' })
  @IsString()
  @MaxLength(16)
  spot!: string;

  @ApiProperty({ description: "Dollars on the spot, in whole chips" })
  @IsNumber()
  amount!: number;
}

class RouletteSpinDto {
  @ApiProperty({ type: [RouletteBetDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SPOTS)
  @ValidateNested({ each: true })
  @Type(() => RouletteBetDto)
  bets!: RouletteBetDto[];
}

class BlackjackDealDto {
  @ApiProperty({ description: "The bet, in dollars, in whole chips" })
  @IsNumber()
  bet!: number;
}

class MinesStartDto {
  @ApiProperty({ enum: [0.5, 1, 2, 5, 10], description: "The stake, in dollars" })
  @IsNumber()
  bet!: number;

  @ApiProperty({ enum: MINE_COUNTS, description: "How many mines are hidden on the 5 by 5 field" })
  @Type(() => Number)
  @IsInt()
  @IsIn([...MINE_COUNTS])
  mines!: number;
}

class MinesRevealDto {
  @ApiProperty({ description: "The tile to open, 0 to 24, left to right and top to bottom" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(TILES - 1)
  tile!: number;
}

class PenaltyStartDto {
  @ApiProperty({ enum: [0.5, 1, 2, 5, 10], description: "The stake, in dollars" })
  @IsNumber()
  bet!: number;
}

class PenaltyKickDto {
  @ApiProperty({ enum: DIRECTIONS, description: "Where the kick is aimed" })
  @IsIn([...DIRECTIONS])
  aim!: "LEFT" | "CENTER" | "RIGHT";
}

class PlinkoDropDto {
  @ApiProperty({ enum: PLINKO_BETS, description: "What the ball costs, in dollars" })
  @IsNumber()
  @IsIn([...PLINKO_BETS])
  bet!: number;

  @ApiProperty({ enum: PLINKO_ROWS, description: "How many rows of pegs the board has" })
  @Type(() => Number)
  @IsInt()
  @IsIn([...PLINKO_ROWS])
  rows!: number;

  @ApiProperty({ enum: PLINKO_RISKS, description: "Which pay table: low keeps most of the stake on most balls, high pays big at the edges" })
  @IsIn([...PLINKO_RISKS])
  risk!: "LOW" | "MEDIUM" | "HIGH";
}

class BlackjackActionDto {
  @ApiProperty({ enum: ["hit", "stand", "double", "split", "insure", "noInsurance"] })
  @IsIn(["hit", "stand", "double", "split", "insure", "noInsurance"])
  action!: "hit" | "stand" | "double" | "split" | "insure" | "noInsurance";
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
  constructor(
    private readonly casino: CasinoService,
    private readonly roulette: RouletteService,
    private readonly blackjack: BlackjackService,
    private readonly book: BookService,
    private readonly mines: MinesService,
    private readonly penalty: PenaltyService,
    private readonly plinko: PlinkoService,
  ) {}

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

  /** The Player's roulette table: can they play, the rules, their last rounds. */
  @Get("roulette")
  @Roles(Role.PLAYER)
  rouletteState(@CurrentActor() actor: Actor) {
    return this.roulette.state(actor);
  }

  /** One round of roulette with the chips on the table. Like a spin, a repeated request gets the first answer back. */
  @Post("roulette/spin")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  rouletteSpin(@CurrentActor() actor: Actor, @Body() body: RouletteSpinDto, @Req() req: AuthenticatedRequest) {
    return this.roulette.spin(actor, body.bets, clientIp(req));
  }

  /** The Player's blackjack table: can they play, the rules, the round in play, their last rounds. */
  @Get("blackjack")
  @Roles(Role.PLAYER)
  blackjackState(@CurrentActor() actor: Actor) {
    return this.blackjack.state(actor);
  }

  /** Deals a round. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("blackjack/deal")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  blackjackDeal(@CurrentActor() actor: Actor, @Body() body: BlackjackDealDto) {
    return this.blackjack.deal(actor, body.bet);
  }

  /** One move in the round being played: hit, stand, double, split, or answer insurance. Idempotent like a deal. */
  @Post("blackjack/action")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @Idempotent()
  blackjackAction(@CurrentActor() actor: Actor, @Body() body: BlackjackActionDto) {
    return this.blackjack.act(actor, body.action);
  }

  /** The Player's Book of Ra: can they play, the rules, free spins in progress, their last spins. */
  @Get("book")
  @Roles(Role.PLAYER)
  bookState(@CurrentActor() actor: Actor) {
    return this.book.state(actor);
  }

  /** One Book of Ra spin, paid or free. Autoplay and free spins come quickly, hence the higher limit. Idempotent like a slot spin. */
  @Post("book/spin")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  bookSpin(@CurrentActor() actor: Actor, @Body() body: BookSpinDto, @Req() req: AuthenticatedRequest) {
    return this.book.spin(actor, body.bet, clientIp(req));
  }

  /** The Player's Mines table: can they play, the rules, the round in play, their last rounds. */
  @Get("mines")
  @Roles(Role.PLAYER)
  minesState(@CurrentActor() actor: Actor) {
    return this.mines.state(actor);
  }

  /** Starts a round. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("mines/start")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  minesStart(@CurrentActor() actor: Actor, @Body() body: MinesStartDto) {
    return this.mines.start(actor, body.bet, body.mines);
  }

  /** Opens one tile. Idempotent like a start. */
  @Post("mines/reveal")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 180, ttl: 60_000 } })
  @Idempotent()
  minesReveal(@CurrentActor() actor: Actor, @Body() body: MinesRevealDto) {
    return this.mines.open(actor, body.tile);
  }

  /** Cashes out the round in play. Idempotent like a start. */
  @Post("mines/cashout")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  minesCashOut(@CurrentActor() actor: Actor) {
    return this.mines.collect(actor);
  }

  /** The Player's penalty shootout: can they play, the rules, the one in play, their last rounds. */
  @Get("penalty")
  @Roles(Role.PLAYER)
  penaltyState(@CurrentActor() actor: Actor) {
    return this.penalty.state(actor);
  }

  /** Starts a shootout. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("penalty/start")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  penaltyStart(@CurrentActor() actor: Actor, @Body() body: PenaltyStartDto) {
    return this.penalty.start(actor, body.bet);
  }

  /** Aims one kick. Idempotent like a start. */
  @Post("penalty/kick")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  penaltyKick(@CurrentActor() actor: Actor, @Body() body: PenaltyKickDto) {
    return this.penalty.shoot(actor, body.aim);
  }

  /** Cashes out the shootout in play. Idempotent like a start. */
  @Post("penalty/cashout")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Idempotent()
  penaltyCashOut(@CurrentActor() actor: Actor) {
    return this.penalty.collect(actor);
  }

  /** The Player's Plinko board: can they play, the pay tables, their last balls. */
  @Get("plinko")
  @Roles(Role.PLAYER)
  plinkoState(@CurrentActor() actor: Actor) {
    return this.plinko.state(actor);
  }

  /** Drops one ball. Players drop them quickly, hence the higher limit; the page never sends more than 5 a second. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("plinko/drop")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 360, ttl: 60_000 } })
  @Idempotent()
  plinkoDrop(@CurrentActor() actor: Actor, @Body() body: PlinkoDropDto, @Req() req: AuthenticatedRequest) {
    return this.plinko.drop(actor, body.bet, body.rows, body.risk, clientIp(req));
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
