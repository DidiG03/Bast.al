import { IsNumber, Max, Min } from "class-validator";

/** Sets a single user's commission rate (Owner's cut to Super Admin, or Manager's cut from their Owner). */
export class CommissionRateDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate!: number;
}
