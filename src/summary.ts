import type { Business } from "./config/types.js";
import type { Notifier } from "./notify.js";
import { agentPaused } from "./safety/killswitch.js";
import { outcomeLines, plainStatus } from "./status.js";
import { readFile } from "node:fs/promises";
import type { Env } from "./config/env.js";
import type { Store } from "./store.js";
import type { Watchdog } from "./safety/watchdog.js";

/** The business's local calendar date (YYYY-MM-DD), hour and weekday, from a UTC instant. */
export function localParts(now: Date, timeZone: string): { date: string; hour: number; weekday: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: String(p.weekday) };
}

/**
 * Emails each owner a weekly summary, once per local week (Monday 8am+ in the business's zone).
 * The once-only key is the local Monday's date, so the UTC rollover at 5pm Phoenix time can't cause a repeat.
 * Safe to call hourly.
 */
export async function sendWeeklySummaries(deps: { env?: Env; store: Store; notify: Notifier; watchdog?: Watchdog; now?: () => Date }, businesses: Business[]): Promise<number> {
  const now = deps.now?.() ?? new Date();
  let sent = 0;
  for (const b of businesses) {
    const local = localParts(now, b.timeZone);
    if (local.weekday !== "Mon" || local.hour < 8 || !b.ownerEmail) continue;
    const key = `weekly-summary:${b.id}`;
    if ((await deps.store.getFlag(key)) === local.date) continue;
    const week = outcomeLines(await deps.store.outcomesSince(b.id, new Date(now.getTime() - 7 * 86_400_000)));
    const paused = deps.env ? await agentPaused({ ...deps, env: deps.env }, b).catch((err: unknown) => ({ paused: true, why: String(err) })) : { paused: false, why: "running" };
    // The owner guide rides along in the first summary only.
    const guideKey = `owner-guide-sent:${b.id}`;
    const guide = (await deps.store.getFlag(guideKey)) ? null : await readFile(new URL("../docs/owner-guide.md", import.meta.url), "utf8").catch(() => null);
    const body = [week.length ? `Last 7 days: ${week.join(", ")}.` : "No calls this week.", await plainStatus(deps, b, paused, now), ...(guide ? ["Your owner guide:", guide] : [])].join("\n\n");
    const r = await deps.notify.email(b.ownerEmail, `Weekly receptionist summary (${b.id})`, body);
    if (r.ok) { await deps.store.setFlag(key, local.date); if (guide) await deps.store.setFlag(`owner-guide-sent:${b.id}`, local.date); sent++; }
  }
  return sent;
}
