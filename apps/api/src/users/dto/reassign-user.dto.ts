import { IsString } from "class-validator";

export class ReassignUserDto {
  @IsString()
  managerId!: string;
}
