import { Type } from "class-transformer";
import { IsDateString, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, Min, ValidateIf } from "class-validator";

export class CommissionPeriodDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class TeamCommissionQueryDto extends CommissionPeriodDto {
  /** Super Admin only: which Owner's team to open. Owners always get their own. */
  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class CommissionHistoryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(26)
  weeks?: number;
}

export class CommissionDailyDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number;
}

/** Send null to remove a limit; leave a field out to keep it. */
export class BettingLimitsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  maxStake?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  dailyLossLimit?: number | null;
}
