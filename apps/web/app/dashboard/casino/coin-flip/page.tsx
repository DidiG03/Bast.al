"use client";

import { CoinFlipGame } from "../../../../components/casino-coin-flip";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function CoinFlipPage() {
  return (
    <PlayersOnly>
      <CoinFlipGame />
    </PlayersOnly>
  );
}
