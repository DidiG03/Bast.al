import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsISO8601, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { MAX_ODDS, MIN_ODDS } from "../odds/pricing";

export const MIN_STAKE = 1;
export const MAX_STAKE = 100_000;
export const MAX_SLIP = 10;

export class SlipBetDto {
  @IsString()
  @MaxLength(64)
  selectionId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_STAKE)
  @Max(MAX_STAKE)
  stake!: number;

  /** The price the Player saw. If it changed, the slip is refused unless acceptOddsChanges is set. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_ODDS)
  @Max(MAX_ODDS)
  odds!: number;
}

export class PlaceBetsDto {
  @ValidateNested({ each: true })
  @Type(() => SlipBetDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SLIP)
  bets!: SlipBetDto[];

  @IsOptional()
  @IsBoolean()
  acceptOddsChanges?: boolean;
}

export class MyBetsQueryDto {
  @IsOptional()
  @IsIn(["open", "settled"])
  status?: "open" | "settled";

  /** Next page: bets placed (open) or settled before this time. */
  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class AdminBetsQueryDto {
  @IsOptional()
  @IsIn(["OPEN", "WON", "LOST", "VOID"])
  status?: "OPEN" | "WON" | "LOST" | "VOID";

  /** Part of a Player's username. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  player?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  eventId?: string;
}

export class VoidDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason!: string;
}

export class ResultDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  home!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  away!: number;
}
