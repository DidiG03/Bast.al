"use client";

import { SlotGame } from "../../../../components/casino-slot";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function SlotPage() {
  return (
    <PlayersOnly>
      <SlotGame />
    </PlayersOnly>
  );
}
