import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";
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
