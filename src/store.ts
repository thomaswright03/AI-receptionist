import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// What the service remembers between requests: in memory, optionally mirrored to a JSON
// file (STATE_FILE) on a persistent disk. Another backend can implement the same Store interface.

/** Throws if the state file's directory can't be created or written; call at start-up so a bad mount stops the service early. */
export function assertWritable(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  accessSync(dirname(file), constants.W_OK);
}

/** Drop calls and events older than `days`; returns how many were removed. */
export const RETENTION_DAYS = 90;

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
  /** From Vapi's end-of-call report. */
  costUsd?: number;
  durationSeconds?: number;
  /** Wording version of the AI + recording disclosure played at the start of the call, and when. */
  disclosureVersion?: string;
  disclosedAt?: string;
  /** A message the caller left, kept so it can't vanish if email or SMS fails. */
  message?: { name: string; callback: string; text: string; urgent: boolean; delivered: "email" | "sms" | "none"; at: string };
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
  listFlags(prefix: string): Promise<[string, string][]>;
  /** Outcome counts since a time, for the owner's status and weekly summary. */
  outcomesSince(businessId: string, since: Date): Promise<Record<string, number>>;
  /** Removes calls and events older than the cutoff. Returns how many were removed. */
  sweep(before: Date): Promise<number>;
  /** Set when the last write to disk failed. */
  lastPersistError?: string;
}

/**
 * In memory; with `file` set, the whole state (calls, events, opt-outs, flags such as
 * the owner's PAUSE and booking keys) is loaded at start and rewritten after every
 * change, so it survives restarts and deploys (put the file on a persistent volume).
 */
export function memoryStore(file?: string): Store {
  const calls = new Map<string, CallRecord>();
  const events: { businessId: string; kind: "call" | "text"; to: string; at: Date; basis?: string; callId?: string }[] = [];
  const optedOut = new Set<string>();
  const flags = new Map<string, string>();
  if (file) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as {
        calls?: CallRecord[]; events?: (typeof events[number] & { at: string })[]; optedOut?: string[]; flags?: [string, string][];
      };
      for (const c of s.calls ?? []) calls.set(c.callId, c);
      for (const e of s.events ?? []) events.push({ ...e, at: new Date(e.at) });
      for (const p of s.optedOut ?? []) optedOut.add(p);
      for (const [k, v] of s.flags ?? []) flags.set(k, v);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // a corrupt state file must stop start-up, not be overwritten
    }
  }
  // A failed write is logged loudly but never fails the call in progress; state stays in memory.
  const persist = () => {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ calls: [...calls.values()], events, optedOut: [...optedOut], flags: [...flags] }));
      renameSync(tmp, file);
      store.lastPersistError = undefined;
    } catch (err) {
      store.lastPersistError = String(err);
      console.error(JSON.stringify({ event: "store.persist.failed", file, err: String(err) }));
    }
  };
  const store: Store = {
    lastPersistError: undefined,
    async saveCall(call) {
      calls.set(call.callId, { ...calls.get(call.callId), ...call });
      persist();
    },
    async getCall(callId) {
      return calls.get(callId);
    },
    async countSince(businessId, kind, since) {
      return events.filter((e) => e.businessId === businessId && e.kind === kind && e.at >= since).length;
    },
    async recordEvent(businessId, kind, to, at, basis, callId) {
      events.push({ businessId, kind, to, at, basis, callId });
      persist();
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
      persist();
      return n; // opt-out status is kept on purpose so the number is still never texted
    },
    async outcomesSince(businessId, since) {
      const out: Record<string, number> = {};
      for (const c of calls.values()) {
        if (c.businessId !== businessId || new Date(c.startedAt) < since) continue;
        out[c.outcome] = (out[c.outcome] ?? 0) + 1;
        if (c.message) out["messages"] = (out["messages"] ?? 0) + 1;
      }
      out["texts"] = events.filter((e) => e.businessId === businessId && e.kind === "text" && e.at >= since).length;
      return out;
    },
    async sweep(before) {
      let n = 0;
      for (const [id, c] of calls) if (new Date(c.startedAt) < before) { calls.delete(id); n++; }
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.at < before) { events.splice(i, 1); n++; }
      if (n) persist();
      return n;
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
      persist();
    },
    async getFlag(key) {
      return flags.get(key);
    },
    async setFlag(key, value) {
      if (value === undefined) flags.delete(key);
      else flags.set(key, value);
      persist();
    },
    async listFlags(prefix) {
      return [...flags].filter(([k]) => k.startsWith(prefix));
    },
  };
  return store;
}
