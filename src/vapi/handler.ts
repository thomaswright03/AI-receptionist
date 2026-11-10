import type { Env } from "../config/env.js";
import type { Business } from "../config/types.js";
import { businessForNumber } from "../config/businesses.js";
import { getFlow } from "../flows/index.js";
import type { Notifier } from "../notify.js";
import { withinHours } from "../safety/hours.js";
import type { Store } from "../store.js";
import type { Watchdog } from "../safety/watchdog.js";
import { missedCallTextBack } from "../textBack.js";
import { DISCLOSURE_VERSION } from "./assistant.js";
import { bookCall, openTimes } from "../tools/calcom.js";
import { buildAssistant, buildStubAssistant, spokenTime } from "./assistant.js";

// Everything Vapi sends to our server URL arrives here as { message: {...} }.
// https://docs.vapi.ai/server-url/events

export interface Deps {
  env: Env;
  businesses: Business[];
  store: Store;
  notify: Notifier;
  watchdog?: Watchdog;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface VapiCall {
  id?: string;
  customer?: { number?: string };
  phoneNumber?: { number?: string };
  assistant?: { metadata?: { businessId?: string } };
  metadata?: { businessId?: string };
}

interface VapiMessage {
  type?: string;
  call?: VapiCall;
  customer?: { number?: string };
  phoneNumber?: { number?: string };
  toolCallList?: { id: string; function?: { name?: string; arguments?: unknown } }[];
  endedReason?: string;
  analysis?: { summary?: string };
  artifact?: { transcript?: string; recordingUrl?: string; messages?: { role?: string }[] };
  status?: string;
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function callerOf(m: VapiMessage): string {
  return m.call?.customer?.number ?? m.customer?.number ?? "unknown";
}

function businessOf(deps: Deps, m: VapiMessage): Business | undefined {
  const id = m.call?.assistant?.metadata?.businessId ?? m.call?.metadata?.businessId;
  if (id) return deps.businesses.find((b) => b.id === id);
  return businessForNumber(deps.businesses, m.call?.phoneNumber?.number ?? m.phoneNumber?.number);
}

export async function handleVapi(deps: Deps, body: unknown): Promise<Record<string, unknown>> {
  const message = ((body as { message?: VapiMessage } | null)?.message ?? {}) as VapiMessage;
  switch (message.type) {
    case "assistant-request":
      return assistantRequest(deps, message);
    case "tool-calls":
      return toolCalls(deps, message);
    case "end-of-call-report":
      await endOfCall(deps, message);
      return {};
    default:
      return {};
  }
}

async function assistantRequest(deps: Deps, m: VapiMessage): Promise<Record<string, unknown>> {
  const now = deps.now?.() ?? new Date();
  const business = businessOf(deps, m);
  if (!business) return { error: "This number is not set up yet." };
  const callsToday = await deps.store.countSince(business.id, "call", new Date(now.getTime() - 24 * 60 * 60 * 1000));
  await deps.store.recordEvent(business.id, "call", callerOf(m), now);
  if (callsToday >= business.caps.callsPerDay && business.ownerPhone) {
    // Over the daily cap: the owner takes the call instead of the agent.
    return { destination: { type: "number", number: business.ownerPhone } };
  }
  if (m.call?.id) {
    await deps.store.saveCall({ callId: m.call.id, businessId: business.id, caller: callerOf(m), startedAt: now.toISOString(), outcome: "unknown", disclosureVersion: DISCLOSURE_VERSION, disclosedAt: now.toISOString() });
  }
  const canTransfer = Boolean(business.ownerPhone) && withinHours(business.transferHours, now, business.timeZone);
  if (deps.env.AGENT_MODE === "stub") return { assistant: buildStubAssistant(deps.env, business, { canTransfer }) };
  const flow = getFlow(business.flowId);
  const times = business.cal
    ? await openTimes(business.cal, now, new Date(now.getTime() + WEEK), deps.env.CAL_API_KEY, deps.fetch)
    : null;
  return { assistant: buildAssistant(deps.env, business, flow, { now, openTimes: times?.slice(0, 15) ?? null, canTransfer }) };
}

async function toolCalls(deps: Deps, m: VapiMessage): Promise<Record<string, unknown>> {
  const business = businessOf(deps, m);
  const results = [];
  for (const call of m.toolCallList ?? []) {
    const raw = call.function?.arguments;
    let args: Record<string, string> = {};
    try {
      args = (typeof raw === "string" ? JSON.parse(raw) : raw ?? {}) as Record<string, string>;
    } catch {
      /* leave empty; the tool reports what's missing */
    }
    const result = business
      ? await runTool(deps, business, m, call.function?.name ?? "", args)
      : { ok: false, say: "Something went wrong on our side. Please call back in a few minutes." };
    results.push({ toolCallId: call.id, result: JSON.stringify(result) });
  }
  return { results };
}

async function runTool(
  deps: Deps,
  business: Business,
  m: VapiMessage,
  name: string,
  args: Record<string, string>,
): Promise<Record<string, unknown>> {
  const caller = callerOf(m);
  const from = business.inboundNumbers[0] ?? "";
  const callId = m.call?.id;
  if (name === "book_discovery_call") {
    if (!business.cal) return { booked: false, say: "Booking isn't available; take a message instead." };
    const { start, name: who, email, need, business_name } = args;
    if (!start || !who || !need) return { booked: false, say: "Missing details: confirm the time, their name and what they need." };
    if (!email || !EMAIL.test(email.trim())) {
      return { booked: false, say: "That email doesn't look complete. Spell it back once more, or take a message if they'd rather not." };
    }
    // One stable key per booking attempt: a retried tool call, or the model
    // calling twice, never books twice. A pending or unclear attempt is never
    // retried from the call; the owner reconciles it in Cal.com.
    const key = `booking:${business.id}:${callId ?? caller}:${start}:${email.trim().toLowerCase()}`;
    const prior = await deps.store.getFlag(key);
    const callBooked = callId ? await deps.store.getFlag(`booked-call:${callId}`) : undefined;
    if (prior?.startsWith("booked") || callBooked) {
      return { booked: true, say: "This call already has a booking. Confirm it with the caller; don't book again." };
    }
    if (prior === "pending" || prior === "uncertain") {
      return { booked: false, say: "Say the owner will confirm the time by text shortly. Do not say it is booked." };
    }
    await deps.store.setFlag(key, "pending");
    const result = await bookCall(
      business.cal,
      {
        start,
        name: who,
        email: email.trim(),
        phone: caller,
        timeZone: business.timeZone,
        notes: `Booked by phone (AI receptionist). Business: ${business_name ?? "not given"}. Need: ${need}`,
      },
      deps.env.CAL_API_KEY,
      deps.fetch,
    );
    const when = spokenTime(start, business.timeZone);
    if (result.booked) {
      await deps.store.setFlag(key, `booked:${result.uid}`);
      if (callId) {
        await deps.store.setFlag(`booked-call:${callId}`, result.uid);
        await deps.store.saveCall({ ...(await baseCall(deps, callId, business, caller)), outcome: "booked" });
      }
      // Caller gets a text confirmation; the owner gets email (texts are kept for what needs action now).
      if (from) await deps.notify.sms(caller, from, `You're booked with ${business.name} for ${when}. A calendar invite is on its way to ${email.trim()}. Reply STOP to opt out.`);
      await deps.notify.email(business.ownerEmail, `Phone booking: ${who}, ${when}`, `${who}\n${business_name ?? ""}\n${caller}\n${email}\n\nNeed: ${need}`);
      return { booked: true, say: `Booked for ${when}. Tell them an invite is going to their email and a text confirmation to their phone.` };
    }
    if (result.reason === "taken") {
      await deps.store.setFlag(key, undefined);
      return { booked: false, say: "That time was just taken. Apologise and offer the next open times." };
    }
    if (result.reason === "uncertain") {
      await deps.store.setFlag(key, "uncertain");
      if (from && business.ownerPhone) {
        await deps.notify.sms(business.ownerPhone, from, `CHECK CAL.COM: booking for ${who} (${caller}, ${email}) at ${when} may or may not have gone through. Need: ${need}`);
      }
      return { booked: false, say: "Say the owner will confirm the time by text shortly. Do not say it is booked." };
    }
    await deps.store.setFlag(key, undefined);
    if (from && business.ownerPhone) {
      await deps.notify.sms(business.ownerPhone, from, `Booking FAILED for ${who} (${caller}, ${email}) at ${when}. Please call them back. Need: ${need}`);
    }
    return { booked: false, say: "Booking failed. Take a message instead and say the owner will call back to set a time." };
  }
  if (name === "take_message") {
    const who = args.name ?? "Unknown caller";
    const back = args.callback_number || caller;
    const urgent = String(args.urgent) === "true";
    if (callId) await deps.store.saveCall({ ...(await baseCall(deps, callId, business, caller)), outcome: "message" });
    // Urgent messages text the owner now; routine ones go to email.
    if (urgent && from && business.ownerPhone) await deps.notify.sms(business.ownerPhone, from, `URGENT message from ${who} (${back}): ${args.message ?? ""}`);
    await deps.notify.email(business.ownerEmail, `${urgent ? "URGENT " : ""}Phone message: ${who}`, `${who}\n${back}\n\n${args.message ?? ""}`);
    return { ok: true, say: "Message passed on. Tell them the owner will call them back, today if possible." };
  }
  return { ok: false, say: "Unknown tool." };
}

async function baseCall(deps: Deps, callId: string, business: Business, caller: string) {
  return (
    (await deps.store.getCall(callId)) ?? {
      callId,
      businessId: business.id,
      caller,
      startedAt: (deps.now?.() ?? new Date()).toISOString(),
      outcome: "unknown" as const,
    }
  );
}

/** Did the call fail before the caller got anywhere? Then they get a text-back. */
export function needsTextBack(endedReason: string | undefined, userTurns: number, outcome: string): boolean {
  if (outcome !== "unknown") return false;
  if (/forwarded|transfer/i.test(endedReason ?? "")) return false;
  if (/error|failed|fault|timed-out|silence/i.test(endedReason ?? "")) return true;
  return /customer-ended/i.test(endedReason ?? "") && userTurns <= 1;
}

async function endOfCall(deps: Deps, m: VapiMessage): Promise<void> {
  const business = businessOf(deps, m);
  const callId = m.call?.id;
  if (!business || !callId) return;
  const caller = callerOf(m);
  const existing = await baseCall(deps, callId, business, caller);
  const userTurns = (m.artifact?.messages ?? []).filter((x) => x.role === "user").length;
  let outcome = existing.outcome;
  if (outcome === "unknown" && /forwarded|transfer/i.test(m.endedReason ?? "")) outcome = "transferred";
  if (needsTextBack(m.endedReason, userTurns, outcome)) {
    await missedCallTextBack({ store: deps.store, notify: deps.notify, now: deps.now?.() }, business, caller, `call ended: ${m.endedReason}`);
    outcome = "text-back";
  }
  await deps.store.saveCall({
    ...existing,
    endedAt: (deps.now?.() ?? new Date()).toISOString(),
    outcome,
    endedReason: m.endedReason,
    summary: m.analysis?.summary,
    transcript: m.artifact?.transcript,
    recordingUrl: m.artifact?.recordingUrl,
  });
}
