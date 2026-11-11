import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// What the service remembers between requests: in memory, optionally mirrored to a JSON
// file (STATE_FILE) on a persistent disk. Another backend can implement the same Store interface.

/** Throws if the state file's directory can't be created or written; call at start-up so a bad mount stops the service early. */
export function assertWritable(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  accessSync(dirname(file), constants.W_OK);
}

/** How long calls, events and booking keys are kept before the retention sweep removes them. */
export const RETENTION_DAYS = 90;
/** Flags whose keys contain caller details and expire with the retention period. */
const EXPIRING_FLAGS = /^(booking:|booked-call:|last-call-at:)/;
/** Flags starting with this are kept in memory only (heartbeats): they never touch the disk. */
export const VOLATILE = "mem:";

export type CallOutcome = "booked" | "transferred" | "message" | "text-back" | "missed" | "unknown";

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
  /** Calls that started since a time, for status checks. */
  recentCalls(businessId: string, since: Date): Promise<CallRecord[]>;
  /** Writes any pending change to disk now (used on shutdown and in tests). */
  flush(): Promise<void>;
  /** Outcome counts since a time, for the owner's status and weekly summary. */
  outcomesSince(businessId: string, since: Date): Promise<Record<string, number>>;
  /** Removes calls, events and expiring flags (booking keys, last-call times) older than the cutoff. Returns how many were removed. */
  sweep(before: Date): Promise<number>;
  /** Set when the last write to disk failed. */
  lastPersistError?: string;
}

/**
 * In memory; with `file` set, the state (calls, events, opt-outs, flags such as the owner's
 * PAUSE and booking keys) is loaded at start and written back in the background, at most
 * once every 250 ms, so a burst of changes during a call costs one non-blocking write.
 * Transcripts live in their own files (`<file>.transcripts/`), out of the hot file.
 * Heartbeat flags (`mem:` prefix) never reach the disk. Put the file on a persistent volume.
 */
export function memoryStore(file?: string): Store {
  const calls = new Map<string, CallRecord>();
  const events: { businessId: string; kind: "call" | "text"; to: string; at: Date; basis?: string; callId?: string }[] = [];
  const optedOut = new Set<string>();
  const flags = new Map<string, string>();
  const flagAt = new Map<string, number>();
  const tdir = file ? `${file}.transcripts` : undefined;
  const tfile = (id: string) => `${tdir}/${id.replace(/[^\w.-]/g, "_")}.txt`;
  if (file) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as {
        calls?: CallRecord[]; events?: (typeof events[number] & { at: string })[]; optedOut?: string[]; flags?: ([string, string] | [string, string, number])[];
      };
      for (const c of s.calls ?? []) calls.set(c.callId, c);
      for (const e of s.events ?? []) events.push({ ...e, at: new Date(e.at) });
      for (const p of s.optedOut ?? []) optedOut.add(p);
      for (const [k, v, at] of s.flags ?? []) { flags.set(k, v); flagAt.set(k, at ?? Date.now()); }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // a corrupt state file must stop start-up, not be overwritten
    }
  }
  // A failed write is logged loudly but never fails the call in progress; state stays in memory.
  let timer: NodeJS.Timeout | undefined;
  let writing: Promise<void> = Promise.resolve();
  const snapshot = () =>
    JSON.stringify({
      calls: [...calls.values()],
      events,
      optedOut: [...optedOut],
      flags: [...flags].filter(([k]) => !k.startsWith(VOLATILE)).map(([k, v]) => [k, v, flagAt.get(k) ?? 0]),
    });
  const writeNow = async () => {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, snapshot());
      await rename(tmp, file);
      store.lastPersistError = undefined;
    } catch (err) {
      store.lastPersistError = String(err);
      console.error(JSON.stringify({ event: "store.persist.failed", file, err: String(err) }));
    }
  };
  const persist = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      writing = writing.then(writeNow);
    }, 250);
    timer.unref();
  };
  const dropTranscript = (id: string) => { if (tdir) rmSync(tfile(id), { force: true }); };
  const readTranscript = (id: string): string | undefined => {
    try { return readFileSync(tfile(id), "utf8"); } catch { return undefined; }
  };
  const store: Store = {
    lastPersistError: undefined,
    async flush() {
      if (timer) { clearTimeout(timer); timer = undefined; writing = writing.then(writeNow); }
      await writing;
    },
    async saveCall(call) {
      const merged = { ...calls.get(call.callId), ...call };
      if (tdir && merged.transcript !== undefined) {
        try {
          mkdirSync(tdir, { recursive: true });
          writeFileSync(tfile(call.callId), merged.transcript);
          delete merged.transcript;
        } catch (err) {
          console.error(JSON.stringify({ event: "store.transcript.failed", callId: call.callId, err: String(err) })); // kept in the record instead
        }
      }
      calls.set(call.callId, merged);
      persist();
    },
    async getCall(callId) {
      const c = calls.get(callId);
      if (!c || !tdir || c.transcript !== undefined) return c;
      const transcript = readTranscript(callId);
      return transcript === undefined ? c : { ...c, transcript };
    },
    async recentCalls(businessId, since) {
      return [...calls.values()].filter((c) => c.businessId === businessId && new Date(c.startedAt) >= since);
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
        calls: [...calls.values()].filter((c) => c.caller === phone).map((c) => ({ ...c, transcript: c.transcript ?? readTranscript(c.callId) })),
        events: events.filter((e) => e.to === phone),
        optedOut: optedOut.has(phone),
      };
    },
    async deleteNumber(phone) {
      let n = 0;
      for (const [id, c] of calls) if (c.caller === phone) { calls.delete(id); dropTranscript(id); n++; }
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
      const texts = events.filter((e) => e.businessId === businessId && e.kind === "text" && e.at >= since).length;
      if (texts) out["texts"] = texts;
      return out;
    },
    async sweep(before) {
      let n = 0;
      for (const [id, c] of calls) if (new Date(c.startedAt) < before) { calls.delete(id); dropTranscript(id); n++; }
      for (const k of [...flags.keys()]) if (EXPIRING_FLAGS.test(k) && (flagAt.get(k) ?? 0) < before.getTime()) { flags.delete(k); flagAt.delete(k); n++; }
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
      if (value === undefined) { flags.delete(key); flagAt.delete(key); }
      else { flags.set(key, value); flagAt.set(key, Date.now()); }
      if (!key.startsWith(VOLATILE)) persist();
    },
    async listFlags(prefix) {
      return [...flags].filter(([k]) => k.startsWith(prefix));
    },
  };
  return store;
}
