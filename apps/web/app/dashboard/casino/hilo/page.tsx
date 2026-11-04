"use client";

import { HiloGame } from "../../../../components/casino-hilo";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function Page() {
  return (
    <PlayersOnly>
      <HiloGame />
    </PlayersOnly>
  );
}
