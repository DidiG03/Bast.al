"use client";

import { RouletteGame } from "../../../../components/casino-roulette";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function RoulettePage() {
  return (
    <PlayersOnly>
      <RouletteGame />
    </PlayersOnly>
  );
}
