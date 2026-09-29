"use client";

import { useTheme } from "./theme-provider";
import { useI18n } from "./i18n-provider";

/** Both icons render and CSS shows the right one, so the first paint matches the device theme. */
export function ThemeToggle() {
  const { toggleTheme } = useTheme();
  const { t } = useI18n();

  return (
    <button
      type="button"
      className="secondary theme-toggle"
      onClick={toggleTheme}
      aria-label={t("Switch between light and dark theme")}
      title={t("Switch between light and dark theme")}
    >
      <svg aria-hidden="true" className="control-icon theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
      </svg>
      <svg aria-hidden="true" className="control-icon theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5 8.5 8.5 0 1 0 20.5 14.3Z" />
      </svg>
      <span className="control-label">{t("Theme")}</span>
    </button>
  );
}
