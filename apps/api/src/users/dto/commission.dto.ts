import { IsNumber, Max, Min } from "class-validator";

export class CommissionRateDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate!: number;
}
