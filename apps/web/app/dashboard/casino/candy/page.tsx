"use client";

import { CandyGame } from "../../../../components/casino-candy";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function Page() {
  return (
    <PlayersOnly>
      <CandyGame />
    </PlayersOnly>
  );
}
