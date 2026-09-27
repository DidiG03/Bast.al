import { IsDateString, IsOptional, IsString } from "class-validator";

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
