import type { Business } from "./config/types.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";

/** Emails each owner a weekly outcome summary, once per ISO-ish week (Monday 8am+ local). Safe to call hourly. */
export async function sendWeeklySummaries(deps: { store: Store; notify: Notifier; now?: () => Date }, businesses: Business[]): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let sent = 0;
  for (const b of businesses) {
    const local = new Date(now.toLocaleString("en-US", { timeZone: b.timeZone }));
    if (local.getDay() !== 1 || local.getHours() < 8 || !b.ownerEmail) continue;
    const key = `weekly-summary:${b.id}`;
    const week = now.toISOString().slice(0, 10);
    if ((await deps.store.getFlag(key)) === week) continue;
    const o = await deps.store.outcomesSince(b.id, new Date(now.getTime() - 7 * 86_400_000));
    const lines = Object.entries(o).map(([k, v]) => `${k}: ${v}`);
    const r = await deps.notify.email(b.ownerEmail, `Weekly receptionist summary (${b.id})`, lines.length ? lines.join("\n") : "No calls this week.");
    if (r.ok) { await deps.store.setFlag(key, week); sent++; }
  }
  return sent;
}
