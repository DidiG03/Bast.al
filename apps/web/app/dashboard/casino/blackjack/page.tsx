"use client";

import { BlackjackGame } from "../../../../components/casino-blackjack";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function BlackjackPage() {
  return (
    <PlayersOnly>
      <BlackjackGame />
    </PlayersOnly>
  );
}
