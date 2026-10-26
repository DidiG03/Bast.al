"use client";

import { useId, useState, type ReactNode } from "react";
import { HelpTip } from "./help-tip";
import { useI18n } from "./i18n-provider";

/**
 * The recent-spins card under a slot. The heading stays on screen and opens
 * the list, which starts closed so a long history doesn't push the cabinet
 * down the page. The "?" beside the title is still its own tip.
 */
export function LastSpins({ title = "Your last spins", help, children }: { title?: string; help: string; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section className="card stack">
      <h2 className="casino-spins-heading">
        <button type="button" className="casino-spins-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          <span className="casino-spins-label">{t(title)}</span>
          {/* The empty stretch of the row, so a tap there opens the list too. The "?" occupies the column this span skips. */}
          <span className="casino-spins-gap" aria-hidden="true" />
          <svg className="casino-spins-chevron" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7 4.5 12.5 10 7 15.5" />
          </svg>
        </button>
        <HelpTip text={help} />
      </h2>
      <div id={panelId} className="casino-spins-panel" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
