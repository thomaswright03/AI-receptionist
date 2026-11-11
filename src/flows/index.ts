import type { Flow } from "../config/types.js";

// Discovery-call booking: the caller is a business owner who may want AI help.
// The agent learns enough for Thomas to prepare, then books a call on Cal.com.
export const discoveryCall: Flow = {
  id: "discovery-call",
  purpose:
    "answer calls for the business, learn what the caller needs, and book a free discovery call with the owner",
  questions: [
    "the caller's first and last name",
    "their business name and what it does",
    "the problem they want help with, in their own words",
    "a good email address for the calendar invite (spell it back letter by letter to confirm)",
  ],
  tools: ["book_discovery_call", "take_message"],
  rules: [
    "Never quote prices, timelines or promise results. Say the owner covers that on the discovery call.",
    "Offer at most three open times at once, read in the caller's words (for example 'Thursday at 2 PM').",
    "Only say a call is booked after book_discovery_call returns booked: true.",
    "If the caller is selling something to the business, take a message instead of booking.",
  ],
};

// Roll-off dumpster calls after hours (Mountain High Disposal). DRAFT: the sizes, price and service-area
// rules and the urgent list are unknown until the client sends them; edit this flow and src/config/faq/mountain-high.ts then.
export const rollOff: Flow = {
  id: "roll-off",
  purpose: "answer after-hours calls for the business, learn what the caller needs, and take a clear message for the team",
  questions: [
    "the caller's name and the best number to call back",
    "the address where the dumpster is needed or is sitting",
    "what they need: a delivery, a pickup, a swap, or a question",
    "the size or kind of job, if they know it",
    "when they need it",
  ],
  tools: ["take_message"],
  rules: [
    "Never quote prices, sizes, availability or service-area promises; say the team will confirm when they open.",
    "Do not book anything. Take a message for every request.",
    "Mark the message urgent only for the cases on the urgent list in the approved answers, or any danger to people.",
    "If the caller is selling something to the business, take a message instead.",
  ],
};

const flows: Record<string, Flow> = { [discoveryCall.id]: discoveryCall, [rollOff.id]: rollOff };

export function getFlow(id: string): Flow {
  const flow = flows[id];
  if (!flow) throw new Error(`Unknown flow: ${id}`);
  return flow;
}
