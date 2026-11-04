"use client";

import { CrashGame } from "../../../../components/casino-crash";
import { PlayersOnly } from "../../../../components/casino-players-only";

export default function Page() {
  return (
    <PlayersOnly>
      <CrashGame />
    </PlayersOnly>
  );
}
