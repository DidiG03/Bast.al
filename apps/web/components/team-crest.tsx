"use client";

import { useState } from "react";

/** A club, fighter or player's picture from the feed. Without one, or if it fails to load, the first letter. */
export function TeamCrest({ name, logo }: { name: string; logo?: string | null }) {
  const [failed, setFailed] = useState(false);
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  if (logo && !failed) return <img className="team-crest" src={logo} alt="" width={22} height={22} onError={() => setFailed(true)} />;
  return (
    <span className="team-badge" aria-hidden="true">
      {letter}
    </span>
  );
}
