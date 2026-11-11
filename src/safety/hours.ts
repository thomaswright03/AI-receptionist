// Local-time helpers for transfer hours and quiet hours.

export interface WeeklyHours {
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** "HH:MM" 24-hour, local to the business. */
  start: string;
  end: string;
}

function localParts(at: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function withinHours(hours: WeeklyHours, at: Date, timeZone: string): boolean {
  const { day, minutes } = localParts(at, timeZone);
  return hours.days.includes(day) && minutes >= toMinutes(hours.start) && minutes < toMinutes(hours.end);
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const QUIET = { days: EVERY_DAY, start: "08:00", end: "21:00" };

export const isHawaiiOrAlaska = (recipient: string) => /^\+1(808|907)/.test(recipient);

/**
 * Texts go out only when it is 8am to 9pm for the recipient. We don't look up the recipient's zone;
 * we require the window to hold in the business zone and in both Eastern and Pacific time, which
 * covers every continental US zone. For a Phoenix business that means about 9am to 7pm Phoenix time
 * in winter and 8am to 6pm in summer. Hawaii (808) and Alaska (907) numbers are never texted.
 */
export function textingAllowed(at: Date, timeZone: string, recipient?: string): boolean {
  if (recipient && isHawaiiOrAlaska(recipient)) return false;
  return [timeZone, "America/New_York", "America/Los_Angeles"].every((tz) => withinHours(QUIET, at, tz));
}
