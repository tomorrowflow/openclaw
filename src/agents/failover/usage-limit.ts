import { createTimeZoneDayKeyFormatter } from "../../infra/format-time/format-datetime.js";
import { parseOffsetlessIsoDateTimeInTimeZone } from "../../infra/format-time/parse-offsetless-zoned-datetime.js";
import { classifyFailoverReason } from "./classify.js";

/** A provider usage or rate limit, with when it resets if the message says. */
export type ProviderUsageLimit = { resetsAt?: number };

// Claude reports "resets 11:10pm (Europe/Berlin)", and a weekly window as
// "resets Dec 1, 9am (Europe/Berlin)".
const RESET_RE =
  /\bresets\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*\(([a-z][\w+-]*(?:\/[\w+-]+)*)\)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 86_400_000;
// Claude names the reset to the minute, so a retry started just after it can
// still hit the limit; a reset that passed this recently means "retry soon",
// not the same time a day or a year later.
const JUST_RESET_MS = 15 * 60_000;
const JUST_RESET_RETRY_MS = 5 * 60_000;
// Longer than a weekly window; a farther result is a misread.
const MAX_RESET_MS = 8 * DAY_MS;

/**
 * Whether an error is a provider usage or rate limit, and the first instant
 * after `now` matching the reset time it names in its IANA zone, or a retry
 * shortly after `now` when that time just passed. Undefined for any other
 * error.
 */
export function parseProviderUsageLimit(
  message: string,
  now: number,
): ProviderUsageLimit | undefined {
  if (classifyFailoverReason(message) !== "rate_limit") {
    return undefined;
  }
  const resetsAt = parseResetTime(message, now);
  return resetsAt === undefined ? {} : { resetsAt };
}

function parseResetTime(message: string, now: number): number | undefined {
  const match = RESET_RE.exec(message);
  if (!match) {
    return undefined;
  }
  const [, monthName, dayRaw, hourRaw, minuteRaw = "0", meridiem, zone] = match;
  let hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return undefined;
    }
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || !zone) {
    return undefined;
  }
  let today: string;
  try {
    today = createTimeZoneDayKeyFormatter(zone)(new Date(now));
  } catch {
    return undefined;
  }
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const month0 = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : -1;
  if (monthName && (month0 < 0 || Number(dayRaw) < 1 || Number(dayRaw) > 31)) {
    return undefined;
  }
  // A dated reset is this year's or next year's; a bare time is the next
  // occurrence, skipping a day where DST makes the time not exist.
  const dates = monthName
    ? [year, year + 1].map((y) => Date.UTC(y, month0, Number(dayRaw)))
    : [0, 1, 2].map((offset) => Date.UTC(year, month - 1, day) + offset * DAY_MS);
  const time = `${pad(hour)}:${pad(minute)}:00`;
  for (const date of dates) {
    const parsed = parseOffsetlessIsoDateTimeInTimeZone(
      `${new Date(date).toISOString().slice(0, 10)}T${time}`,
      zone,
    );
    const at = parsed.ok ? Date.parse(parsed.iso) : undefined;
    if (at === undefined || at <= now - JUST_RESET_MS) {
      continue;
    }
    if (at <= now) {
      return now + JUST_RESET_RETRY_MS;
    }
    return at - now <= MAX_RESET_MS ? at : undefined;
  }
  return undefined;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
