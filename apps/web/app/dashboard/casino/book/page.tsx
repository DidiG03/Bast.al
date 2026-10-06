"use client";

import { BookGame } from "../../../../components/casino-book";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function BookPage() {
  return (
    <PlayersOnly>
      <BookGame />
    </PlayersOnly>
  );
}
