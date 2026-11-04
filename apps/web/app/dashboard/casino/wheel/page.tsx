"use client";

import { WheelGame } from "../../../../components/casino-wheel";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function Page() {
  return (
    <PlayersOnly>
      <WheelGame />
    </PlayersOnly>
  );
}
