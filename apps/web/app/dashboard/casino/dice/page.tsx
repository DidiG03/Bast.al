"use client";

import { DiceGame } from "../../../../components/casino-dice";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function DicePage() {
  return (
    <PlayersOnly>
      <DiceGame />
    </PlayersOnly>
  );
}
