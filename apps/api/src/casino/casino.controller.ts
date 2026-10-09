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
import { DiceService } from "./dice.service";
import { KenoService } from "./keno.service";
import { BETS as KENO_BETS, MAX_PICKS as KENO_MAX_PICKS, MIN_PICKS as KENO_MIN_PICKS, NUMBERS as KENO_NUMBERS } from "./keno";
import { BETS as DICE_BETS, DIRECTIONS as DICE_DIRECTIONS } from "./dice";
import { CoinFlipService } from "./coin-flip.service";
import { BETS as COIN_BETS, SIDES as COIN_SIDES } from "./coin-flip";
import { ScratchService } from "./scratch.service";
import { BETS as SCRATCH_BETS } from "./scratch";
import { BETS as BOOK_BETS } from "./book";
import { BETS as MINES_BETS, MINE_COUNTS, TILES } from "./mines";
import { BETS as PENALTY_BETS, DIRECTIONS } from "./penalty";
import { BETS as PLINKO_BETS, RISKS as PLINKO_RISKS, ROWS as PLINKO_ROWS } from "./plinko";

class SpinDto {
  @ApiProperty({ enum: BETS, description: "What the spin costs, in ALL. Ignored while the Player has free spins left from the old game." })
  @IsNumber()
  @IsIn([...BETS])
  bet!: number;
}

class BookSpinDto {
  @ApiProperty({ enum: BOOK_BETS, description: "What the spin costs, in ALL. Ignored during free spins, which play at the bet that started them." })
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
  @ApiProperty({ description: "The bet, in ALL, in whole chips" })
  @IsNumber()
  bet!: number;
}

class MinesStartDto {
  @ApiProperty({ enum: MINES_BETS, description: "The stake, in ALL" })
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
  @ApiProperty({ enum: PENALTY_BETS, description: "The stake, in ALL" })
  @IsNumber()
  bet!: number;
}

class PenaltyKickDto {
  @ApiProperty({ enum: DIRECTIONS, description: "Where the kick is aimed" })
  @IsIn([...DIRECTIONS])
  aim!: "LEFT" | "CENTER" | "RIGHT";
}

class PlinkoDropDto {
  @ApiProperty({ enum: PLINKO_BETS, description: "What the ball costs, in ALL" })
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

class DiceRollDto {
  @ApiProperty({ enum: DICE_BETS, description: "The stake, in ALL" })
  @IsNumber()
  @IsIn([...DICE_BETS])
  bet!: number;

  @ApiProperty({ description: "The target, 0.00 to 99.99, in hundredths" })
  @IsNumber()
  @Min(0)
  @Max(99.99)
  target!: number;

  @ApiProperty({ enum: DICE_DIRECTIONS, description: "UNDER wins on rolls below the target, OVER on rolls above it" })
  @IsIn([...DICE_DIRECTIONS])
  direction!: "UNDER" | "OVER";
}

class DiceSeedDto {
  @ApiProperty({ required: false, description: "The new client seed: 1 to 32 letters, digits, dashes or underscores. Left out, a random one." })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  clientSeed?: string;
}

class KenoPlayDto {
  @ApiProperty({ enum: KENO_BETS, description: "What the round costs, in ALL" })
  @IsNumber()
  @IsIn([...KENO_BETS])
  bet!: number;

  @ApiProperty({ type: [Number], minItems: KENO_MIN_PICKS, maxItems: KENO_MAX_PICKS, description: `${KENO_MIN_PICKS} to ${KENO_MAX_PICKS} different numbers from 1 to ${KENO_NUMBERS}` })
  @IsArray()
  @ArrayMinSize(KENO_MIN_PICKS)
  @ArrayMaxSize(KENO_MAX_PICKS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(KENO_NUMBERS, { each: true })
  picks!: number[];
}

class CoinFlipDto {
  @ApiProperty({ enum: COIN_BETS, description: "What the flip costs, in ALL" })
  @IsNumber()
  @IsIn([...COIN_BETS])
  bet!: number;

  @ApiProperty({ enum: COIN_SIDES, description: "The side the Player calls" })
  @IsIn([...COIN_SIDES])
  call!: "HEADS" | "TAILS";
}

class ScratchBuyDto {
  @ApiProperty({ enum: SCRATCH_BETS, description: "What the card costs, in ALL" })
  @IsNumber()
  @IsIn([...SCRATCH_BETS])
  bet!: number;
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
    private readonly dice: DiceService,
    private readonly keno: KenoService,
    private readonly coinFlip: CoinFlipService,
    private readonly scratch: ScratchService,
  ) {}

  /** The game for the home page's "Continue playing": a round still in play, or the game played last. */
  @Get("last-game")
  @Roles(Role.PLAYER)
  async lastGame(@CurrentActor() actor: Actor) {
    return { last: await this.casino.lastGame(actor) };
  }

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

  /** The Player's dice table: can they play, the rules, their seed pair, their last rolls. */
  @Get("dice")
  @Roles(Role.PLAYER)
  diceState(@CurrentActor() actor: Actor) {
    return this.dice.state(actor);
  }

  /** One roll. Autoplay rolls quickly, hence the higher limit. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("dice/roll")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Idempotent()
  diceRoll(@CurrentActor() actor: Actor, @Body() body: DiceRollDto, @Req() req: AuthenticatedRequest) {
    return this.dice.roll(actor, body.bet, body.target, body.direction, clientIp(req));
  }

  /** Changes the Player's seed pair, showing the old server seed so its rolls can be checked. */
  @Post("dice/seed")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  diceSeed(@CurrentActor() actor: Actor, @Body() body: DiceSeedDto) {
    return this.dice.changeSeed(actor, body.clientSeed);
  }

  /** The Player's Keno board: can they play, the rules and pay table, their seed pair, their last rounds. */
  @Get("keno")
  @Roles(Role.PLAYER)
  kenoState(@CurrentActor() actor: Actor) {
    return this.keno.state(actor);
  }

  /** One Keno draw. Autoplay plays quickly, hence the higher limit. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("keno/play")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  kenoPlay(@CurrentActor() actor: Actor, @Body() body: KenoPlayDto, @Req() req: AuthenticatedRequest) {
    return this.keno.play(actor, body.bet, body.picks, clientIp(req));
  }

  /** Changes the Player's seed pair (shared with Dice), showing the old server seed so its draws can be checked. */
  @Post("keno/seed")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  kenoSeed(@CurrentActor() actor: Actor, @Body() body: DiceSeedDto) {
    return this.dice.changeSeed(actor, body.clientSeed);
  }

  /** The Player's coin: can they play, the rules, their seed pair, their last flips. */
  @Get("coin-flip")
  @Roles(Role.PLAYER)
  coinFlipState(@CurrentActor() actor: Actor) {
    return this.coinFlip.state(actor);
  }

  /** One coin flip. Autoplay flips quickly, hence the higher limit. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("coin-flip/flip")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @Idempotent()
  coinFlipFlip(@CurrentActor() actor: Actor, @Body() body: CoinFlipDto) {
    return this.coinFlip.flip(actor, body.bet, body.call);
  }

  /** Changes the Player's seed pair (shared with Dice and Keno), showing the old server seed so its flips can be checked. */
  @Post("coin-flip/seed")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  coinFlipSeed(@CurrentActor() actor: Actor, @Body() body: DiceSeedDto) {
    return this.dice.changeSeed(actor, body.clientSeed);
  }

  /** The Player's scratch cards: can they play, the prizes, their seed pair, their last cards. */
  @Get("scratch")
  @Roles(Role.PLAYER)
  scratchState(@CurrentActor() actor: Actor) {
    return this.scratch.state(actor);
  }

  /** Buys one scratch card, paid at once. Autoplay buys quickly, hence the higher limit. A repeated request with the same Idempotency-Key gets the first answer back. */
  @Post("scratch/buy")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Idempotent()
  scratchBuy(@CurrentActor() actor: Actor, @Body() body: ScratchBuyDto, @Req() req: AuthenticatedRequest) {
    return this.scratch.buy(actor, body.bet, clientIp(req));
  }

  /** Changes the Player's seed pair (shared with Dice, Keno and Coin Flip), showing the old server seed so its cards can be checked. */
  @Post("scratch/seed")
  @Roles(Role.PLAYER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  scratchSeed(@CurrentActor() actor: Actor, @Body() body: DiceSeedDto) {
    return this.dice.changeSeed(actor, body.clientSeed);
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
