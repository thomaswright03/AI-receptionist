import type { Business } from "./config/types.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";
import { missedCallTextBack } from "./textBack.js";

/** A call with no end-of-call report after this long is treated as one whose report was lost. */
export const UNFINISHED_AFTER_MS = 20 * 60_000;
const LOOKBACK_MS = 7 * 86_400_000;

/** Calls that started a while ago and never got an end-of-call report. */
export async function unfinishedCalls(store: Store, businesses: Business[], now: Date) {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const all = (await Promise.all(businesses.map((b) => store.recentCalls(b.id, since)))).flat();
  return all.filter((c) => !c.endedAt && now.getTime() - new Date(c.startedAt).getTime() > UNFINISHED_AFTER_MS);
}

/**
 * Closes calls whose end-of-call report never arrived (service restart, 5xx, network). A call with no
 * result yet is treated as missed: the caller is texted back (if allowed) and the owner is told. A call that
 * already booked or left a message is just closed. Each call is closed first-thing-after-acting, so a second
 * run does nothing. Run every few minutes.
 */
export async function reconcileUnfinishedCalls(deps: { store: Store; notify: Notifier; now?: () => Date }, businesses: Business[]): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let closed = 0;
  for (const call of await unfinishedCalls(deps.store, businesses, now)) {
    const business = businesses.find((b) => b.id === call.businessId);
    if (!business) continue;
    let outcome = call.outcome;
    // Close the record before acting: if the process dies mid-way, a missed text is better than a double one.
    await deps.store.saveCall({ ...call, endedAt: now.toISOString(), endedReason: "report-lost", outcome: call.outcome === "unknown" ? "text-back" : call.outcome });
    if (outcome === "unknown") {
      await missedCallTextBack({ store: deps.store, notify: deps.notify, now }, business, call.caller, "the call's final report never arrived", call.callId);
      outcome = "text-back";
    }
    closed++;
  }
  return closed;
}
