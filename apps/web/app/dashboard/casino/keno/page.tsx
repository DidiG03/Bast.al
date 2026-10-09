"use client";

import { KenoGame } from "../../../../components/casino-keno";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function KenoPage() {
  return (
    <PlayersOnly>
      <KenoGame />
    </PlayersOnly>
  );
}
