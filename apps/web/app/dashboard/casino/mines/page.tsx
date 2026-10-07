"use client";

import { MinesGame } from "../../../../components/casino-mines";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function MinesPage() {
  return (
    <PlayersOnly>
      <MinesGame />
    </PlayersOnly>
  );
}
