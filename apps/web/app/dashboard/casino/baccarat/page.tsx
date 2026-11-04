"use client";

import { BaccaratGame } from "../../../../components/casino-baccarat";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function Page() {
  return (
    <PlayersOnly>
      <BaccaratGame />
    </PlayersOnly>
  );
}
