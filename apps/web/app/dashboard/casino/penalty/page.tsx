"use client";

import { PenaltyGame } from "../../../../components/casino-penalty";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function PenaltyPage() {
  return (
    <PlayersOnly>
      <PenaltyGame />
    </PlayersOnly>
  );
}
