// What the service remembers between requests. In memory for now so the
// whole call path can be built and tested; the Postgres version (week 1)
// implements the same interface, so nothing else changes when it lands.

export type CallOutcome = "booked" | "transferred" | "message" | "abandoned" | "text-back" | "unknown";

export interface CallRecord {
  callId: string;
  businessId: string;
  caller: string;
  startedAt: string;
  endedAt?: string;
  outcome: CallOutcome;
  endedReason?: string;
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
}

export interface Store {
  saveCall(call: CallRecord): Promise<void>;
  getCall(callId: string): Promise<CallRecord | undefined>;
  /** Counts events of a kind for a business since a time, for the daily caps. */
  countSince(businessId: string, kind: "call" | "text", since: Date): Promise<number>;
  recordEvent(businessId: string, kind: "call" | "text", to: string, at: Date): Promise<void>;
  lastTextTo(businessId: string, to: string): Promise<Date | undefined>;
  isOptedOut(phone: string): Promise<boolean>;
  setOptOut(phone: string, optedOut: boolean): Promise<void>;
}

export function memoryStore(): Store {
  const calls = new Map<string, CallRecord>();
  const events: { businessId: string; kind: "call" | "text"; to: string; at: Date }[] = [];
  const optedOut = new Set<string>();
  return {
    async saveCall(call) {
      calls.set(call.callId, { ...calls.get(call.callId), ...call });
    },
    async getCall(callId) {
      return calls.get(callId);
    },
    async countSince(businessId, kind, since) {
      return events.filter((e) => e.businessId === businessId && e.kind === kind && e.at >= since).length;
    },
    async recordEvent(businessId, kind, to, at) {
      events.push({ businessId, kind, to, at });
    },
    async lastTextTo(businessId, to) {
      const sent = events.filter((e) => e.businessId === businessId && e.kind === "text" && e.to === to);
      return sent.at(-1)?.at;
    },
    async isOptedOut(phone) {
      return optedOut.has(phone);
    },
    async setOptOut(phone, value) {
      if (value) optedOut.add(phone);
      else optedOut.delete(phone);
    },
  };
}
