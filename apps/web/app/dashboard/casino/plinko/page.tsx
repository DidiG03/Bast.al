"use client";

import { PlinkoGame } from "../../../../components/casino-plinko";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function PlinkoPage() {
  return (
    <PlayersOnly>
      <PlinkoGame />
    </PlayersOnly>
  );
}
