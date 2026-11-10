import type { Business } from "./config/types.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";
import { textingAllowed } from "./safety/hours.js";

const DAY = 24 * 60 * 60 * 1000;

export type TextBackResult = { sent: true } | { sent: false; why: string };

// Texts a caller whose call was missed, at most once in any rolling 24 hours, never to an
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
  const queued = result.sent === false && result.why.startsWith("outside 8am-9pm");
  if (queued && from && business.ownerPhone) {
    await deps.notify.sms(business.ownerPhone, from, `Missed call from ${caller} (${reason}). Texting is closed now; they will be texted back when it opens.`);
  } else if (result.sent === false && from && business.ownerPhone) {
    await deps.notify.sms(business.ownerPhone, from, `Missed call from ${caller} (${reason}). No text-back sent: ${result.why}.`);
  } else if (from && business.ownerPhone) {
    await deps.notify.sms(business.ownerPhone, from, `Missed call from ${caller} (${reason}). They were texted back.`);
  }
  return result;

  async function decide(): Promise<TextBackResult> {
    if (!from) return { sent: false, why: "business has no number" };
    if (!/^\+1\d{10}$/.test(caller)) return { sent: false, why: "caller number is hidden or not a US mobile format" };
    if (await deps.store.isOptedOut(caller)) return { sent: false, why: "caller opted out" };
    if (!textingAllowed(now, business.timeZone, caller)) {
      // Not lost: queued, and sent by flushDeferredTextBacks when the window opens (within 24 hours).
      await deps.store.setFlag(`${DEFERRED}${business.id}|${caller}`, JSON.stringify({ at: now.toISOString(), reason, callId }));
      return { sent: false, why: "outside 8am-9pm for the recipient; queued to send when texting is allowed" };
    }
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

const DEFERRED = "deferred-textback:";

/** Sends queued text-backs whose window has opened; drops ones older than 24 hours. Run every minute. */
export async function flushDeferredTextBacks(
  deps: { store: Store; notify: Notifier; now?: () => Date },
  businesses: Business[],
): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let handled = 0;
  for (const [key, raw] of await deps.store.listFlags(DEFERRED)) {
    const [businessId, caller] = key.slice(DEFERRED.length).split("|") as [string, string];
    const business = businesses.find((b) => b.id === businessId);
    let item: { at: string; reason: string; callId?: string };
    try {
      item = JSON.parse(raw) as typeof item;
      if (Number.isNaN(new Date(item.at).getTime())) throw new Error("bad date");
    } catch (err) {
      console.error(JSON.stringify({ event: "textback.bad-entry", key, err: String(err) }));
      await deps.store.setFlag(key, undefined);
      continue;
    }
    if (!business) { await deps.store.setFlag(key, undefined); continue; }
    if (now.getTime() - new Date(item.at).getTime() > DAY) { await deps.store.setFlag(key, undefined); continue; }
    if (!textingAllowed(now, business.timeZone, caller)) continue;
    await deps.store.setFlag(key, undefined);
    await missedCallTextBack({ store: deps.store, notify: deps.notify, now }, business, caller, `${item.reason}, queued overnight`, item.callId);
    handled++;
  }
  return handled;
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
// Plain requests that are unmistakably about texting: "stop texting me", "please don't text me again".
// Deliberately narrow: "can you stop by Tuesday? text me the price" must not match.
const STOP_INTENT = /\b(stop|quit|cease|don'?t|do not|no more)\s+(texting|messaging|text|message)\s+(me|us)\b|\b(remove me|take me off)\s+(from\s+)?(your|the|this)\s+(list|texts?)\b|\bopt me out\b|\bunsubscribe me\b|\bleave me alone\b/i;
const START_WORDS = /^\s*(start|unstop)\s*$/i;

export type OptOutKind = "keyword" | "intent" | "start" | null;

/**
 * Handles STOP/START on inbound texts. Exact carrier keywords opt out silently. Plain-language
 * requests also opt out but are reported as "intent" so the caller can forward the text to the
 * owner and confirm. Anything else returns null and is forwarded.
 */
export async function handleOptOut(store: Store, from: string, body: string): Promise<OptOutKind> {
  if (STOP_WORDS.test(body)) {
    await store.setOptOut(from, true);
    return "keyword";
  }
  if (STOP_INTENT.test(body)) {
    await store.setOptOut(from, true);
    return "intent";
  }
  if (START_WORDS.test(body)) {
    await store.setOptOut(from, false);
    return "start";
  }
  return null;
}
