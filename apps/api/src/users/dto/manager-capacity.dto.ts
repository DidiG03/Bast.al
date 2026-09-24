import { IsInt, IsPositive, Max } from "class-validator";

export class ManagerCapacityDto {
  @IsInt()
  @IsPositive()
  @Max(100000)
  capacity!: number;
}
