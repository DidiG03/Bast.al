import { IsNumber, Max, Min } from "class-validator";

export class CommissionDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  percentage!: number;
}
