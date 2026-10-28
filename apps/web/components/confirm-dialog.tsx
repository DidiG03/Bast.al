"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n-provider";

export type ConfirmOptions = {
  title: string;
  /** What will happen, in a sentence or two. */
  message?: ReactNode;
  /** The button that goes ahead: "Void match", "Close the Casino". */
  confirmLabel: string;
  /** Red, for something that takes money or access away or can't be undone. */
  danger?: boolean;
};

/**
 * Asks before a risky action goes ahead, in the site's own dialog: `confirm`
 * resolves true only if the person presses the button that goes ahead
 * (Cancel, ×, Escape or a click beside it resolve false). Render `dialog`
 * somewhere in the component.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [asking, setAsking] = useState<{ options: ConfirmOptions; resolve: (yes: boolean) => void } | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setAsking({ options, resolve })), []);
  const answer = useCallback(
    (yes: boolean) => {
      asking?.resolve(yes);
      setAsking(null);
    },
    [asking],
  );
  return [confirm, asking ? <ConfirmModal options={asking.options} onAnswer={answer} /> : null];
}

function ConfirmModal({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (yes: boolean) => void }) {
  const { t } = useI18n();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Cancel has the focus, so Enter by reflex doesn't go ahead.
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onAnswer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onAnswer(false)}>
      <section className="modal card confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-header">
          <h2 id="confirm-title">{options.title}</h2>
          <button type="button" className="modal-close secondary" onClick={() => onAnswer(false)} aria-label={t("Close")}>×</button>
        </div>
        {options.message ? <p style={{ margin: 0 }}>{options.message}</p> : null}
        <div className="modal-actions">
          <button ref={cancel} type="button" className="secondary" onClick={() => onAnswer(false)}>{t("Cancel")}</button>
          <button type="button" className={options.danger ? "danger-button" : ""} onClick={() => onAnswer(true)}>{options.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
