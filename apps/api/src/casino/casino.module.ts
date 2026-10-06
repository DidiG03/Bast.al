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

@Module({
  imports: [AuthModule, SecurityModule, UsersModule, CommissionsModule],
  controllers: [CasinoController],
  providers: [CasinoService, RouletteService, BlackjackService, BookService],
  exports: [CasinoService, RouletteService, BlackjackService, BookService],
})
export class CasinoModule {}
