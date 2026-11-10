// How the product is configured: business -> flow -> shared tools.
//
// A business is one customer (Wright AI Solutions, later Mountain High): its
// numbers, hours, voice and where bookings go. A flow is one kind of call
// (a discovery-call booking, a roll-off quote, a junk-removal estimate),
// written once per trade and reused by every business in that trade. Tools
// are the shared actions a flow may use mid-call.

import type { WeeklyHours } from "../safety/hours.js";

export type ToolName = "book_discovery_call" | "take_message";

export interface Flow {
  id: string;
  /** What the agent is for, in one line, for the system prompt. */
  purpose: string;
  /** What the agent must learn before it can finish, in the order to ask. */
  questions: string[];
  /** Mid-call tools this flow may use. Transfer and end-call are always on. */
  tools: ToolName[];
  /** Extra rules for this flow, appended to the shared rules. */
  rules: string[];
}

export interface CalEvent {
  username: string;
  slug: string;
}

export interface Business {
  id: string;
  name: string;
  /** What the business does, in a sentence the agent can say. */
  about: string;
  /** IANA time zone used for hours, quiet hours and spoken times. */
  timeZone: string;
  flowId: string;
  /** Who transfers ring and who gets missed-call and booking alerts (E.164). */
  ownerPhone: string;
  ownerEmail: string;
  /** Twilio numbers that belong to this business (E.164). */
  inboundNumbers: string[];
  /** Name the agent uses for itself. */
  agentName: string;
  voice: { provider: string; voiceId: string };
  cal?: CalEvent;
  /** When transfers may ring the owner; outside these the agent takes a message. */
  transferHours: WeeklyHours;
  /** Approved answers the agent may give (services, pricing wording, who we are). */
  faq: { q: string; a: string }[];
  /** Text sent to a caller whose call was missed. */
  textBack: string;
  /** Hard daily limits, on top of the kill switch. */
  caps: { callsPerDay: number; textsPerDay: number };
}
