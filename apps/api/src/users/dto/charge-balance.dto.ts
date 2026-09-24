import { ApiProperty } from "@nestjs/swagger";
import { IsNumber, IsPositive, Max } from "class-validator";

export class ChargeBalanceDto {
  @ApiProperty({ example: 100, description: "Amount to credit to the manager account" })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  amount!: number;
}
