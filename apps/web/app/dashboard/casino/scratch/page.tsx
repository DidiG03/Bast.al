"use client";

import { PlayersOnly } from "../../../../components/casino-players-only";
import { ScratchGame } from "../../../../components/casino-scratch";

export default function ScratchPage() {
  return (
    <PlayersOnly>
      <ScratchGame />
    </PlayersOnly>
  );
}
