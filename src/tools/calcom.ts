import type { CalEvent } from "../config/types.js";

// Cal.com v2, called the same way the Wright AI website's worker calls it
// (worker/services.js there), so both book the same event the same way.
const CAL_API = "https://api.cal.com/v2";

function headers(apiKey: string | undefined, version: string): Record<string, string> {
  return {
    "cal-api-version": version,
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await p(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Open start times between two dates, sorted ISO strings (UTC), or null if Cal.com can't be reached. */
export async function openTimes(
  cal: CalEvent,
  from: Date,
  to: Date,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  const query = new URLSearchParams({
    username: cal.username,
    eventTypeSlug: cal.slug,
    start: from.toISOString(),
    end: to.toISOString(),
  });
  try {
    const response = await withTimeout(
      (signal) => fetchImpl(`${CAL_API}/slots?${query}`, { headers: headers(apiKey, "2024-09-04"), signal }),
      4000,
    );
    if (!response.ok) return null;
    const days = ((await response.json()) as { data?: unknown } | null)?.data;
    if (!days || typeof days !== "object") return null;
    const times = new Set<string>();
    for (const list of Object.values(days)) {
      if (!Array.isArray(list)) continue;
      for (const slot of list) {
        const start = Date.parse(typeof slot === "string" ? slot : (slot as { start?: string })?.start ?? "");
        if (Number.isFinite(start)) times.add(new Date(start).toISOString());
      }
    }
    return [...times].sort();
  } catch {
    return null;
  }
}

export type BookingResult =
  | { booked: true; uid: string; start: string }
  | { booked: false; reason: "taken" | "uncertain" | "refused" };

/**
 * Books the call; Cal.com then emails both people the invite. "uncertain"
 * means it may have been booked anyway (timeout, 5xx), so the agent must not
 * say either way and the owner is alerted to check.
 */
export async function bookCall(
  cal: CalEvent,
  booking: { start: string; name: string; email: string; phone: string; timeZone: string; notes: string },
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BookingResult> {
  let response: Response;
  try {
    response = await withTimeout(
      (signal) =>
        fetchImpl(`${CAL_API}/bookings`, {
          method: "POST",
          headers: headers(apiKey, "2026-02-25"),
          body: JSON.stringify({
            start: booking.start,
            attendee: { name: booking.name, email: booking.email, timeZone: booking.timeZone, phoneNumber: booking.phone, language: "en" },
            eventTypeSlug: cal.slug,
            username: cal.username,
            bookingFieldsResponses: { notes: booking.notes },
            metadata: { source: "ai-receptionist" },
          }),
          signal,
        }),
      8000,
    );
  } catch {
    return { booked: false, reason: "uncertain" };
  }
  if (response.status >= 500 && response.status !== 503) return { booked: false, reason: "uncertain" };
  const result = (await response.json().catch(() => null)) as { data?: unknown; error?: unknown } | null;
  if (response.ok) {
    const data = result?.data;
    const b = (Array.isArray(data) ? data[0] : data) as { uid?: string; start?: string } | undefined;
    return b ? { booked: true, uid: String(b.uid ?? ""), start: b.start ?? booking.start } : { booked: false, reason: "uncertain" };
  }
  const message = JSON.stringify(result?.error ?? result ?? "");
  if ([400, 409].includes(response.status) && /not available|already has (a )?booking|no available|unavailable|slot|booking limit/i.test(message)) {
    return { booked: false, reason: "taken" };
  }
  return { booked: false, reason: "refused" };
}
