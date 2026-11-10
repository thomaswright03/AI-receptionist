import { readFileSync, writeFileSync } from "node:fs";

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
  /** Wording version of the AI + recording disclosure played at the start of the call, and when. */
  disclosureVersion?: string;
  disclosedAt?: string;
}

export interface Store {
  saveCall(call: CallRecord): Promise<void>;
  getCall(callId: string): Promise<CallRecord | undefined>;
  /** Counts events of a kind for a business since a time, for the daily caps. */
  countSince(businessId: string, kind: "call" | "text", since: Date): Promise<number>;
  recordEvent(businessId: string, kind: "call" | "text", to: string, at: Date, basis?: string, callId?: string): Promise<void>;
  /** Everything held about a number, and its removal (delete-by-number). */
  exportNumber(phone: string): Promise<unknown>;
  deleteNumber(phone: string): Promise<number>;
  lastTextTo(businessId: string, to: string): Promise<Date | undefined>;
  isOptedOut(phone: string): Promise<boolean>;
  setOptOut(phone: string, optedOut: boolean): Promise<void>;
  /** Small switches that must survive between requests (e.g. a business paused by its owner). */
  getFlag(key: string): Promise<string | undefined>;
  setFlag(key: string, value: string | undefined): Promise<void>;
}

export function memoryStore(): Store {
  const calls = new Map<string, CallRecord>();
  const events: { businessId: string; kind: "call" | "text"; to: string; at: Date; basis?: string; callId?: string }[] = [];
  const optedOut = new Set<string>();
  const flags = new Map<string, string>();
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
    async recordEvent(businessId, kind, to, at, basis, callId) {
      events.push({ businessId, kind, to, at, basis, callId });
    },
    async exportNumber(phone) {
      return {
        calls: [...calls.values()].filter((c) => c.caller === phone),
        events: events.filter((e) => e.to === phone),
        optedOut: optedOut.has(phone),
      };
    },
    async deleteNumber(phone) {
      let n = 0;
      for (const [id, c] of calls) if (c.caller === phone) { calls.delete(id); n++; }
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.to === phone) { events.splice(i, 1); n++; }
      return n; // opt-out status is kept on purpose so the number is still never texted
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
    async getFlag(key) {
      return flags.get(key);
    },
    async setFlag(key, value) {
      if (value === undefined) flags.delete(key);
      else flags.set(key, value);
    },
  };
}

/** Wraps a store so opt-outs survive restarts: they are loaded from, and written to, a JSON file. */
export function withPersistentOptOuts(inner: Store, file: string): Store {
  const loaded = new Set<string>();
  try {
    for (const p of JSON.parse(readFileSync(file, "utf8")) as string[]) loaded.add(p);
  } catch {
    /* no file yet */
  }
  const save = () => writeFileSync(file, JSON.stringify([...loaded]));
  return {
    ...inner,
    async isOptedOut(phone) {
      return loaded.has(phone) || inner.isOptedOut(phone);
    },
    async setOptOut(phone, value) {
      if (value) loaded.add(phone);
      else loaded.delete(phone);
      save();
      await inner.setOptOut(phone, value);
    },
  };
}
