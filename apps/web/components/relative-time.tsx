"use client";

import { useEffect, useState } from "react";
import { useI18n } from "./i18n-provider";

const MINUTE = 60_000;
const EXACT: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };

/** "Just now", "5 min ago", "3 h ago", then the date; the exact time shows on hover. Updates itself every minute. */
export function RelativeTime({ value, className }: { value: string; className?: string }) {
  const { t, date } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE);
    return () => window.clearInterval(timer);
  }, []);
  const ago = Math.max(0, now - new Date(value).getTime());
  const text =
    ago < MINUTE
      ? t("Just now")
      : ago < 60 * MINUTE
        ? t("{count} min ago", { count: Math.floor(ago / MINUTE) })
        : ago < 12 * 60 * MINUTE
          ? t("{count} h ago", { count: Math.floor(ago / (60 * MINUTE)) })
          : date(value, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <time className={className} dateTime={value} title={date(value, EXACT)} suppressHydrationWarning>
      {text}
    </time>
  );
}
