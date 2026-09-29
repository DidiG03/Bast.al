"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

type ThemeContextValue = {
  /** What is on screen right now. */
  theme: Theme;
  /** The saved choice, or null while the app follows the device setting. */
  choice: Theme | null;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const DARK_QUERY = "(prefers-color-scheme: dark)";

function applyTheme(choice: Theme | null) {
  if (choice) document.documentElement.setAttribute("data-theme", choice);
  else document.documentElement.removeAttribute("data-theme");
}

/**
 * Follows the device's light or dark setting until someone flips the toggle.
 * Flipping back to what the device already shows clears the saved choice, so
 * the app goes back to following the device.
 */
export function ThemeProvider({ children, initialTheme }: { children: ReactNode; initialTheme: Theme | null }) {
  const [choice, setChoice] = useState<Theme | null>(initialTheme);
  const [system, setSystem] = useState<Theme>("dark");

  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const sync = () => setSystem(query.matches ? "dark" : "light");
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const theme = choice ?? system;
  const pathname = usePathname();

  // The browser's own chrome (mobile status bar, address bar) is told the
  // page's color via <meta name="theme-color">. Player pages are always dark
  // regardless of the light/dark toggle (their theme is fixed), so reading
  // the *actual* rendered --bg — from the dashboard shell if there is one,
  // the <html> element otherwise — is the only way this stays correct for
  // every role and every toggle state, not just the two static colors a
  // plain light/dark media query can express. Re-runs on navigation too,
  // since a Player route and an admin route can disagree while `theme` itself
  // hasn't changed.
  useEffect(() => {
    const target = document.querySelector<HTMLElement>(".dashboard-shell") ?? document.documentElement;
    const bg = getComputedStyle(target).getPropertyValue("--bg").trim();
    if (!bg) return;
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", bg));
  }, [theme, pathname]);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const saved = next === system ? null : next;
    setChoice(saved);
    applyTheme(saved);
    document.cookie = saved
      ? `bastal-theme=${saved}; path=/; max-age=31536000; samesite=lax`
      : "bastal-theme=; path=/; max-age=0; samesite=lax";
  }, [system, theme]);

  return (
    <ThemeContext.Provider value={{ theme, choice, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
