import type { Business } from "./config/types.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";
import { textingAllowed } from "./safety/hours.js";

const DAY = 24 * 60 * 60 * 1000;

export type TextBackResult = { sent: true } | { sent: false; why: string };

// Texts a caller whose call was missed, once a day at most, never to an
// opted-out number, never outside 8am-9pm local, never past the daily cap.
// The owner is alerted either way, so a missed call never goes unseen.
export async function missedCallTextBack(
  deps: { store: Store; notify: Notifier; now?: Date },
  business: Business,
  caller: string,
  reason: string,
  callId?: string,
): Promise<TextBackResult> {
  const now = deps.now ?? new Date();
  const from = business.inboundNumbers[0];
  const result = await decide();
  if (result.sent === false && from && business.ownerPhone) {
    await deps.notify.sms(business.ownerPhone, from, `Missed call from ${caller} (${reason}). No text-back sent: ${result.why}.`);
  } else if (from && business.ownerPhone) {
    await deps.notify.sms(business.ownerPhone, from, `Missed call from ${caller} (${reason}). They were texted back.`);
  }
  return result;

  async function decide(): Promise<TextBackResult> {
    if (!from) return { sent: false, why: "business has no number" };
    if (!/^\+1\d{10}$/.test(caller)) return { sent: false, why: "caller number is hidden or not a US mobile format" };
    if (await deps.store.isOptedOut(caller)) return { sent: false, why: "caller opted out" };
    if (!textingAllowed(now, business.timeZone, caller)) return { sent: false, why: "outside 8am-9pm for the recipient" };
    const last = await deps.store.lastTextTo(business.id, caller);
    if (last && now.getTime() - last.getTime() < DAY) return { sent: false, why: "already texted in the last 24 hours" };
    const today = await deps.store.countSince(business.id, "text", new Date(now.getTime() - DAY));
    if (today >= business.caps.textsPerDay) return { sent: false, why: "daily text cap reached" };
    const sent = await deps.notify.sms(caller, from, business.textBack);
    if (!sent.ok) return { sent: false, why: `send failed: ${sent.error}` };
    await deps.store.recordEvent(business.id, "text", caller, now, "reply_to_inbound_call", callId);
    return { sent: true };
  }
}

/** The one door for texts to callers: never to an opted-out number. */
export async function sendCallerSms(
  deps: { store: Store; notify: Notifier },
  to: string,
  from: string,
  body: string,
): Promise<{ sent: boolean; why?: string }> {
  if (await deps.store.isOptedOut(to)) return { sent: false, why: "caller opted out" };
  const r = await deps.notify.sms(to, from, body);
  return r.ok ? { sent: true } : { sent: false, why: r.error };
}

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt[- ]out)\s*$/i;
// Plain requests such as "stop texting me" or "please don't text me again".
const STOP_INTENT = /\b(stop|quit|cease|don'?t|do not|no more|remove me|take me off|leave me alone)\b.{0,30}\b(text|texts|texting|message|messages|messaging|contact|contacting|calling|list)\b|\bopt me out\b|\bunsubscribe\b/i;
const START_WORDS = /^\s*(start|unstop|yes)\s*$/i;

/** Handles STOP/START on inbound texts. Returns true when the message was an opt-out keyword. */
export async function handleOptOut(store: Store, from: string, body: string): Promise<boolean> {
  if (STOP_WORDS.test(body) || STOP_INTENT.test(body)) {
    await store.setOptOut(from, true);
    return true;
  }
  if (START_WORDS.test(body)) {
    await store.setOptOut(from, false);
    return true;
  }
  return false;
}
