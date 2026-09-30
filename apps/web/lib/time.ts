/**
 * The app runs on Albanian time, wherever the page is drawn: the server
 * (which runs on UTC) and every browser show the same dates and times, and
 * days and weeks start at midnight in Tirana, as they do in the API (see
 * apps/api/src/time.ts). Weeks start on Monday.
 */
export const TIME_ZONE = "Europe/Tirane";

const clockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

type Clock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The date and time on a clock in Tirana at this moment (month 1–12). */
function wallClock(at: Date): Clock {
  const parts: Record<string, number> = {};
  for (const part of clockFormat.formatToParts(at)) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return parts as Clock;
}

/** How far Tirana's clocks are ahead of UTC at this moment, in milliseconds. */
function offsetAt(at: Date): number {
  const clock = wallClock(at);
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - Math.floor(at.getTime() / 1000) * 1000;
}

/** Midnight in Tirana at the start of this date (month 1–12; a day past the month's end rolls over). */
export function midnight(year: number, month: number, day: number): Date {
  const utc = Date.UTC(year, month - 1, day);
  return new Date(utc - offsetAt(new Date(utc - offsetAt(new Date(utc)))));
}

export function startOfDay(at: Date): Date {
  const clock = wallClock(at);
  return midnight(clock.year, clock.month, clock.day);
}

/** Midnight `days` days after (or before, when negative) the day `at` falls on. */
export function addDays(at: Date, days: number): Date {
  const clock = wallClock(at);
  return midnight(clock.year, clock.month, clock.day + days);
}

/** Monday 00:00 of the week `at` falls in. */
export function startOfWeek(at: Date): Date {
  const clock = wallClock(at);
  const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
  return midnight(clock.year, clock.month, clock.day - ((weekday + 6) % 7));
}

/** The 1st of the month `at` falls in, at midnight. */
export function startOfMonth(at: Date): Date {
  const clock = wallClock(at);
  return midnight(clock.year, clock.month, 1);
}

/** "2026-09-21": the day `at` falls on, for comparing days. */
export function dayKey(at: Date | string | number): string {
  const clock = wallClock(new Date(at));
  return `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
}

/** Whether `at` falls today (0), tomorrow (1) and so on. */
export function isDaysFromToday(at: Date | string | number, days: number): boolean {
  return dayKey(at) === dayKey(addDays(new Date(), days));
}

/** Midnight at the start of a date picked in a date field ("2026-09-21"), or null if it isn't one. */
export function fromDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? midnight(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/** The last moment of a date picked in a date field, for a filter that includes that whole day. */
export function endOfDateInput(value: string): Date | null {
  const start = fromDateInput(value);
  return start ? new Date(addDays(start, 1).getTime() - 1) : null;
}
