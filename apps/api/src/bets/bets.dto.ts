import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsISO8601, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { MAX_ODDS, MIN_ODDS } from "../odds/pricing";
import { MAX_BUILDER_ODDS, MAX_BUILDER_PICKS } from "./builder";
import { MAX_SYSTEM_PICKS, MIN_SYSTEM_LINE_STAKE, MIN_SYSTEM_PICKS } from "./system";

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

export class AccumulatorLegDto {
  @IsString()
  @MaxLength(64)
  selectionId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_ODDS)
  @Max(MAX_ODDS)
  odds!: number;
}

export class AccumulatorDto {
  @ValidateNested({ each: true })
  @Type(() => AccumulatorLegDto)
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_SLIP)
  legs!: AccumulatorLegDto[];

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_STAKE)
  @Max(MAX_STAKE)
  stake!: number;
}

export class BuilderDto {
  @ValidateNested({ each: true })
  @Type(() => AccumulatorLegDto)
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_BUILDER_PICKS)
  legs!: AccumulatorLegDto[];

  /** The builder's price the Player saw. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_ODDS)
  @Max(MAX_BUILDER_ODDS)
  odds!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_STAKE)
  @Max(MAX_STAKE)
  stake!: number;
}

export class SystemDto {
  @ValidateNested({ each: true })
  @Type(() => AccumulatorLegDto)
  @ArrayMinSize(MIN_SYSTEM_PICKS)
  @ArrayMaxSize(MAX_SYSTEM_PICKS)
  legs!: AccumulatorLegDto[];

  /** The sizes of line: 2 for the doubles, 3 for the trebles; 1 for the singles. */
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_SYSTEM_PICKS, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SYSTEM_PICKS)
  sizes!: number[];

  /** The stake on each line; the system costs this times the number of lines. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_SYSTEM_LINE_STAKE)
  @Max(MAX_STAKE)
  lineStake!: number;
}

export class BuilderQuoteDto {
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_BUILDER_PICKS)
  selectionIds!: string[];
}

export class PlaceBetsDto {
  /** Singles. */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SlipBetDto)
  @ArrayMaxSize(MAX_SLIP)
  bets?: SlipBetDto[];

  /** At most one accumulator per slip. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AccumulatorDto)
  accumulator?: AccumulatorDto;

  /** At most one bet builder per slip. */
  @IsOptional()
  @ValidateNested()
  @Type(() => BuilderDto)
  builder?: BuilderDto;

  /** At most one system bet per slip. */
  @IsOptional()
  @ValidateNested()
  @Type(() => SystemDto)
  system?: SystemDto;

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

  /** One Player exactly, by id. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  playerId?: string;

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

/** Super Admin's own result for one outcome the feed can't settle (e.g. a goalscorer whose name matches no one for sure). */
export class SelectionResultDto {
  @IsIn(["WON", "LOST", "VOID"])
  result!: "WON" | "LOST" | "VOID";
}

export class ResultDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  home!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  away!: number;

  /** The half-time score, for the half markets. Send both or neither. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  halfHome?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  halfAway?: number;

  /** Corners and cards (every yellow and red counts as one), for the corner and card markets. Send all four or none. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  cornersHome?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  cornersAway?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  cardsHome?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  cardsAway?: number;
}

export class RiskQueryDto {
  /** Super Admin only: whose team. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string;
}

export class RiskCapDto {
  /** Null removes the cap. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100_000_000)
  maxOutcomePayout!: number | null;
}
