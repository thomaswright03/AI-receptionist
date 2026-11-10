import type { Business } from "../config/types.js";
import { businessForNumber } from "../config/businesses.js";
import { agentPaused } from "../safety/killswitch.js";
import { handleOptOut, missedCallTextBack } from "../textBack.js";
import type { Deps } from "../vapi/handler.js";

// Twilio webhooks. The Twilio number's voice URL points at /twilio/voice, so
// the switch between agent and owner lives here, in one place, for every
// business: normally the call is handed to Vapi; when the agent is paused it
// dials the owner. If this service itself is down, the number's Voice
// Fallback URL (a static TwiML Bin that dials the owner) takes over. Carrier
// settings never change.

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const twiml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

export type Params = Record<string, string>;

export async function voice(deps: Deps, p: Params): Promise<string> {
  const business = businessForNumber(deps.businesses, p.To);
  if (!business) return twiml("<Say>This number is not in service.</Say><Hangup/>");
  const paused = await agentPaused(deps.env, deps.fetch);
  if (!paused.paused) {
    return twiml(`<Redirect method="POST">${xml(deps.env.VAPI_TWILIO_INBOUND_URL)}</Redirect>`);
  }
  console.log(JSON.stringify({ event: "agent.paused", business: business.id, why: paused.why }));
  return dialOwner(deps, business);
}

function dialOwner(deps: Deps, business: Business): string {
  if (!business.ownerPhone) return missedTwiml();
  const action = `${deps.env.PUBLIC_URL}/twilio/dial-result`;
  return twiml(`<Dial timeout="20" action="${xml(action)}" method="POST">${xml(business.ownerPhone)}</Dial>`);
}

function missedTwiml(): string {
  return twiml("<Say>Sorry we missed you. We'll text you right away so we can help.</Say><Hangup/>");
}

/** After dialing the owner: if nobody picked up, text the caller back. */
export async function dialResult(deps: Deps, p: Params): Promise<string> {
  const business = businessForNumber(deps.businesses, p.To);
  if (p.DialCallStatus === "completed" || !business) return twiml("<Hangup/>");
  await missedCallTextBack({ store: deps.store, notify: deps.notify, now: deps.now?.() }, business, p.From ?? "", `owner did not answer (${p.DialCallStatus})`);
  return missedTwiml();
}

/** The number's call-status callback: catches calls that never reached anyone. */
export async function status(deps: Deps, p: Params): Promise<void> {
  if (!["busy", "no-answer", "failed"].includes(p.CallStatus ?? "")) return;
  const business = businessForNumber(deps.businesses, p.To);
  if (!business) return;
  await missedCallTextBack({ store: deps.store, notify: deps.notify, now: deps.now?.() }, business, p.From ?? "", `call ${p.CallStatus}`);
}

/** Inbound texts: honour STOP/START, forward everything else to the owner. */
export async function sms(deps: Deps, p: Params): Promise<string> {
  const from = p.From ?? "";
  const body = p.Body ?? "";
  if (await handleOptOut(deps.store, from, body)) return twiml("");
  const business = businessForNumber(deps.businesses, p.To);
  if (business?.ownerPhone && p.To) {
    await deps.notify.sms(business.ownerPhone, p.To, `Text from ${from}: ${body}`);
  }
  return twiml("");
}
