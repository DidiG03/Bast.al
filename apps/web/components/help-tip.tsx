"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "./i18n-provider";

/**
 * The "!" next to a card's title: tap it (or hover on a computer) to read, in
 * plain words, what the card shows and how it works. `text` is English and is
 * shown in the reader's language; add its Albanian to lib/i18n/sq/help.ts.
 */
export function HelpTip({ text, vars }: { text: string; vars?: Record<string, string | number> }) {
  const { t } = useI18n();
  // Hovering shows the tip on a computer; a tap or click keeps it open until tapped again or elsewhere.
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || pinned;
  const [alignRight, setAlignRight] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    // Open towards the side with room, so the bubble never runs off the screen.
    const box = wrapper.current?.getBoundingClientRect();
    if (box) setAlignRight(box.left > window.innerWidth / 2);
    const close = (event: MouseEvent | TouchEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) {
        setPinned(false);
        setHover(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPinned(false);
      setHover(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="help-tip" ref={wrapper} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type="button"
        className="help-tip-button"
        aria-label={t("How this works")}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(event) => {
          // Inside a <summary> or a link, the tap is only for the tip.
          event.preventDefault();
          event.stopPropagation();
          // Already showing from a hover: the click keeps it; otherwise it opens or closes it.
          setPinned((value) => (hover && !value ? true : !value));
        }}
      >
        !
      </button>
      {open ? (
        <span id={id} role="tooltip" className={`help-tip-bubble${alignRight ? " is-right" : ""}`}>
          {t(text, vars)}
        </span>
      ) : null}
    </span>
  );
}
