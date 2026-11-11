import type { Business } from "./config/types.js";
import type { CallRecord, Store } from "./store.js";
import { VOLATILE } from "./store.js";

// Results of the scheduled jobs and plain-language status for the owner. Job heartbeats are
// kept in memory only (`mem:` flags): a "success" is recorded only after the job finished.

export const JOBS = {
  textback: { label: "Queued text-back job", everyMs: 60_000 },
  weekly: { label: "Weekly summary job", everyMs: 3_600_000 },
  sweep: { label: "Retention sweep", everyMs: 6 * 3_600_000 },
} as const;
export type JobName = keyof typeof JOBS;

const okKey = (j: JobName) => `${VOLATILE}job:${j}:ok`;
const errKey = (j: JobName) => `${VOLATILE}job:${j}:err`;

/** Runs a job; records a success only if it finished, or the one-line error if it threw. Never throws. */
export async function runJob(store: Store, job: JobName, run: () => Promise<unknown>, now: () => Date = () => new Date()): Promise<void> {
  try {
    await run();
    await store.setFlag(okKey(job), now().toISOString());
    await store.setFlag(errKey(job), undefined);
  } catch (err) {
    const line = String(err).split("\n")[0]!.slice(0, 200);
    console.error(JSON.stringify({ event: `${job}.error`, err: String(err) }));
    await store.setFlag(errKey(job), `${now().toISOString()} ${line}`).catch(() => undefined);
  }
}

export async function jobState(store: Store, job: JobName, now: Date) {
  const lastOk = (await store.getFlag(okKey(job))) ?? null;
  const lastErr = (await store.getFlag(errKey(job))) ?? null;
  const age = lastOk ? now.getTime() - new Date(lastOk).getTime() : Infinity;
  const stale = age > JOBS[job].everyMs * 3 + 30_000;
  const status = lastErr ? ("down" as const) : lastOk ? (stale ? ("down" as const) : ("ok" as const)) : ("unknown" as const);
  const next = lastOk ? new Date(new Date(lastOk).getTime() + JOBS[job].everyMs).toISOString() : null;
  return { lastOk, lastErr, status, next };
}

const OUTCOME_WORDS: Record<string, string> = {
  booked: "booked a call",
  transferred: "passed to a person",
  message: "left a message",
  "text-back": "missed, texted back",
  unknown: "no clear result",
  messages: "messages taken",
  texts: "texts sent",
};
export const outcomeWords = (o: string) => OUTCOME_WORDS[o] ?? o;

/** "customer-ended-call" → "the caller hung up"; anything unrecognised is shown as given. */
export function endedWords(reason: string | undefined): string {
  if (!reason) return "not recorded";
  if (/customer-ended/i.test(reason)) return "the caller hung up";
  if (/assistant-ended|assistant-said-end/i.test(reason)) return "the receptionist finished the call";
  if (/forwarded|transfer/i.test(reason)) return "the call was passed to a person";
  if (/silence/i.test(reason)) return "nobody spoke";
  if (/error|failed|fault|timed-out/i.test(reason)) return `a technical problem (${reason})`;
  return reason;
}

export const callFailed = (c: CallRecord) => /error|failed|fault|timed-out/i.test(c.endedReason ?? "");

export function outcomeLines(o: Record<string, number>): string[] {
  return Object.entries(o).map(([k, v]) => `${v} ${outcomeWords(k)}`);
}

/** Problems the owner should hear about, in plain words (empty = all fine). */
export async function problems(deps: { store: Store; watchdog?: { healthy: boolean; lastError?: string } }, business: Business | undefined, now: Date): Promise<string[]> {
  const out: string[] = [];
  if (deps.store.lastPersistError) out.push("Saving data to disk is failing, so calls and messages could be lost if the service restarts.");
  for (const j of Object.keys(JOBS) as JobName[]) {
    const s = await jobState(deps.store, j, now);
    if (s.status === "down") out.push(`${JOBS[j].label} is not working${s.lastErr ? `: ${s.lastErr.split(" ").slice(1).join(" ")}` : " (it has stopped running)"}.`);
  }
  if (deps.watchdog && !deps.watchdog.healthy) out.push(`The health watchdog has tripped: ${deps.watchdog.lastError ?? "unknown"}.`);
  if (business) {
    const calls = await deps.store.recentCalls(business.id, new Date(now.getTime() - 7 * 86_400_000));
    const lost = calls.filter((c) => c.message && c.message.delivered === "none").length;
    if (lost) out.push(`${lost} message${lost > 1 ? "s were" : " was"} saved but could not be sent to you. Ask for them.`);
  }
  return out;
}

/** The owner's plain-language view: today's calls, queued text-backs, anything down. */
export async function plainStatus(
  deps: { store: Store; watchdog?: { healthy: boolean; lastError?: string } },
  business: Business,
  paused: { paused: boolean; why: string },
  now: Date,
): Promise<string> {
  const today = outcomeLines(await deps.store.outcomesSince(business.id, new Date(now.getTime() - 86_400_000)));
  const queued = (await deps.store.listFlags(`deferred-textback:${business.id}|`)).length;
  const issues = await problems(deps, business, now);
  return [
    paused.paused ? `Calls ring your cell: ${paused.why}.` : "Calls go to the AI receptionist.",
    today.length ? `Last 24 hours: ${today.join(", ")}.` : "Last 24 hours: no calls.",
    `Text-backs waiting for morning: ${queued}.`,
    issues.length ? `Needs attention: ${issues.join(" ")}` : "Nothing is broken.",
  ].join(" ");
}
