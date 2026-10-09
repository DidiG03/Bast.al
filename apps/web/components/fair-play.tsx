"use client";

import type { ReactNode } from "react";
import { useI18n } from "./i18n-provider";

/** Pieces the provably fair games (Dice and Keno) share: their sheets, the seed lines in them, and the shield icon. */

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal card casino-rules dice-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close secondary" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function SeedLine({ label, value, onCopy }: { label: string; value: string; onCopy?: (text: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="dice-seed-line">
      <small>{label}</small>
      <span>
        <code>{value}</code>
        {onCopy && value ? (
          <button type="button" className="dice-copy" onClick={() => onCopy(value)} aria-label={t("Copy")} title={t("Copy")}>
            ⧉
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
