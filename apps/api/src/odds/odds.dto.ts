import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { MAX_MARGIN, MAX_ODDS, MIN_ODDS } from "./pricing";

export class TeamQueryDto {
  /** Super Admin only: whose team prices to show or change. Owners always get their own. */
  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class EventsQueryDto extends TeamQueryDto {
  @IsOptional()
  @IsIn(["upcoming", "live", "finished"])
  filter?: "upcoming" | "live" | "finished";
}

export class BaseMarginDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MARGIN)
  margin!: number;
}

export class TeamMarginDto {
  /** Can be negative, down to minus the base margin. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-MAX_MARGIN)
  @Max(MAX_MARGIN)
  margin!: number;
}

export class OverrideDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(MIN_ODDS)
  @Max(MAX_ODDS)
  odds!: number;
}

export class UpdateEventDto {
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @IsBoolean()
  suspended?: boolean;
}

/** Super Admin's pick of competitions to sync. `reset` goes back to the defaults. */
export class LeaguesDto {
  @IsOptional()
  @IsBoolean()
  reset?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(400)
  @IsInt({ each: true })
  @Min(1, { each: true })
  leagues?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  countries?: string[];
}
