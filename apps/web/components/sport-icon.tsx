import type { Sport } from "../lib/api";

/** Each sport's icon, drawn in the text's colour: an outline with a soft fill, so it reads on the dark tabs and the bright one alike. */
export function SportIcon({ sport }: { sport: Sport }) {
  if (sport === "football")
    // A football: the centre panel and the five around the edge filled in.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <path d="M12 8.4 15.4 10.9 14.1 14.9H9.9L8.6 10.9Z M12.0 5.6 L15.9 3.3 L8.1 3.3Z M18.1 10.0 L21.4 13.0 L19.1 5.6Z M15.8 17.2 L14.0 21.3 L20.2 16.8Z M8.2 17.2 L3.8 16.8 L10.0 21.3Z M5.9 10.0 L4.9 5.6 L2.6 13.0Z" fill="currentColor" />
        <path d="M12 8.4V5.6M15.4 10.9l2.7-.9M14.1 14.9l1.7 2.3M9.9 14.9l-1.7 2.3M8.6 10.9l-2.7-.9" />
        <circle cx="12" cy="12" r="9.5" />
      </svg>
    );
  if (sport === "greyhounds")
    // A greyhound at full stretch, facing right: body and head filled, legs and tail drawn.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M6.5 10.2C8.5 8.6 12.5 8.4 15.6 9.4L18.6 6.6C19.2 6 20.2 5.9 20.8 6.4L23 8L22.6 8.8L20.2 8.9C19.3 9.4 18.6 10.6 18 12C17.4 13.4 16.2 13.9 14.8 13.6C12.8 13.1 11.4 12.3 10 12.5C8.6 12.7 7.4 13.2 6.6 13C5.6 12.6 5.6 11 6.5 10.2Z"
          fill="currentColor"
        />
        <path d="M16 13.2 19.2 15.2 22.6 15.6M15 13.5l2.4 2.9 3.2 1.2M7.6 12.6l-3 3.2-3 .4M8.8 12.8 6.6 17l-3 1.2M6.6 10.6c-2-.4-3.6.2-5.2 1.8M19.2 6.6l-1-1.2 1.6.5" />
      </svg>
    );
  if (sport === "basketball")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <circle cx="12" cy="12" r="9.5" />
        <path d="M2.5 12h19M12 2.5v19M5.3 5.3C7.4 7.2 8.6 9.5 8.6 12s-1.2 4.8-3.3 6.7M18.7 5.3c-2.1 1.9-3.3 4.2-3.3 6.7s1.2 4.8 3.3 6.7" />
      </svg>
    );
  if (sport === "nfl")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <ellipse cx="12" cy="12" rx="10" ry="5.8" transform="rotate(-45 12 12)" fill="currentColor" fillOpacity="0.16" />
        <ellipse cx="12" cy="12" rx="10" ry="5.8" transform="rotate(-45 12 12)" />
        {/* The laces along the seam, and a stripe near each end. */}
        <path d="M9.2 14.8 14.8 9.2M9.6 12.6l1.8 1.8M11.1 11.1l1.8 1.8M12.6 9.6l1.8 1.8M5.4 14.2l4.4 4.4M14.2 5.4l4.4 4.4" />
      </svg>
    );
  if (sport === "volleyball")
    // A volleyball: three curved panels meeting in the middle.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 12c0-4 1.6-7.2 4.4-9M12 12c-3.5 2-7.1 2.2-10.2 1.1M12 12c3.5 2 5.4 5.1 5.9 8.3M7.6 3.6c2.6 2.4 3.8 5.3 3.4 8.6M21.4 11.2c-3.2-1.4-6.3-1.1-9 .8M5 18.6c2.4-2.6 5.3-4.1 7-6.6" />
      </svg>
    );
  if (sport === "handball")
    // A handball: its panels, a size smaller than a football.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" fill="currentColor" fillOpacity="0.16" />
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 3.5v17M3.5 12h17M6 6c2.5 1.8 3.8 3.8 3.8 6S8.5 16.2 6 18M18 6c-2.5 1.8-3.8 3.8-3.8 6s1.3 4.2 3.8 6" />
      </svg>
    );
  if (sport === "tennis")
    // A tennis ball: its two curved seams.
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" fill="currentColor" fillOpacity="0.16" />
        <circle cx="12" cy="12" r="9.5" />
        <path d="M5.2 5.4C8.6 8.6 8.6 15.4 5.2 18.6M18.8 5.4c-3.4 3.2-3.4 10 0 13.2" />
      </svg>
    );
  // MMA: a fighter's glove, open at the fingers, with its wrist strap.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 11V7.6A3.6 3.6 0 0 1 10.1 4h3.6a4.8 4.8 0 0 1 4.8 4.8v4.6a5 5 0 0 1-5 5h-2.4a4.6 4.6 0 0 1-4.6-4.6z" fill="currentColor" fillOpacity="0.16" />
      <path d="M6.5 11V7.6A3.6 3.6 0 0 1 10.1 4h3.6a4.8 4.8 0 0 1 4.8 4.8v4.6a5 5 0 0 1-5 5h-2.4a4.6 4.6 0 0 1-4.6-4.6z" />
      <path d="M6.5 11.4h3.6a2.1 2.1 0 0 0 0-4.2H8.4M10.5 4v3.2M14 4.2v3M17.6 6.4 18.5 9" />
      <path d="M8.6 18v2.6h7v-2.8" />
    </svg>
  );
}
