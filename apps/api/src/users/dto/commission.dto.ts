import {IsNumber, IsOptional, Max, Min, ValidateIf} from "class-validator";

/** Sets a single user's commission rate (Owner's cut to Super Admin, or Manager's cut from their Owner). */
export class CommissionRateDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate!: number;

  /** The Casino's rate, when it differs from the one on matches; null (or left out) means the same as `rate`. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  casinoRate?: number | null;
}
