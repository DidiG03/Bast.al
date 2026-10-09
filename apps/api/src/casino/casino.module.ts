import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CommissionsModule } from "../commissions/commissions.module";
import { SecurityModule } from "../security/security.module";
import { UsersModule } from "../users/users.module";
import { CasinoController } from "./casino.controller";
import { CasinoService } from "./casino.service";
import { RouletteService } from "./roulette.service";
import { BlackjackService } from "./blackjack.service";
import { BookService } from "./book.service";
import { MinesService } from "./mines.service";
import { PenaltyService } from "./penalty.service";
import { PlinkoService } from "./plinko.service";
import { DiceService } from "./dice.service";
import { KenoService } from "./keno.service";

@Module({
  imports: [AuthModule, SecurityModule, UsersModule, CommissionsModule],
  controllers: [CasinoController],
  providers: [CasinoService, RouletteService, BlackjackService, BookService, MinesService, PenaltyService, PlinkoService, DiceService, KenoService],
  exports: [CasinoService, RouletteService, BlackjackService, BookService, MinesService, PenaltyService, PlinkoService, DiceService, KenoService],
})
export class CasinoModule {}
