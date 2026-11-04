"use client";

import { TowerGame } from "../../../../components/casino-tower";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function Page() {
  return (
    <PlayersOnly>
      <TowerGame />
    </PlayersOnly>
  );
}
