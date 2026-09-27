import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

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
