import { readFile, stat } from "node:fs/promises";
import { ALERT_FAILED_KEY, ALERT_OK_KEY } from "./alerts.js";
import { sendKey } from "./notify.js";
import { agentPaused } from "./safety/killswitch.js";
import { callFailed, JOBS, jobState, plainStatus, type JobName } from "./status.js";
import { unfinishedCalls } from "./reconcile.js";
import { openTimes } from "./tools/calcom.js";
import type { Deps } from "./vapi/handler.js";

// The owner/operator status in the standard tiered shape. Every row comes from a real check or a recorded
// result; a row says "unknown" until it has been checked. Overall counts Important rows only.

type St = "ok" | "warning" | "down" | "unknown";
type Tier = "important" | "key" | "basic";
type Opts = { checked?: boolean; lastSuccess?: string | null; next?: string | null };

const DAY = 86_400_000;

export async function buildStatus(deps: Deps, cfgMissing: string[], now: Date) {
  const iso = now.toISOString();
  // last_checked is set only for rows actually evaluated from a recorded result now; null otherwise.
  const fn = (tier: Tier, name: string, status: St, detail: string, o: Opts = {}) =>
    ({ name, tier, status, detail, last_checked: o.checked === false ? null : iso, last_success: o.lastSuccess ?? null, next_expected_run: o.next ?? null });
  const week = new Date(now.getTime() - 7 * DAY);

  const rows = [
    ...(await callRows(deps, fn, now, week)),
    await calRow(deps, fn, now, iso),
    ...(await integrationRows(deps, fn)),
    storageRow(deps, fn, iso),
    fn("important", "Live configuration", cfgMissing.length ? (deps.env.DRY_RUN === "false" ? "down" : "warning") : "ok", cfgMissing.length ? `missing: ${cfgMissing.join(", ")}` : "all present", { lastSuccess: cfgMissing.length ? null : iso }),
    ...(await Promise.all((Object.keys(JOBS) as JobName[]).map(async (j) => {
      const s = await jobState(deps.store, j, now);
      return fn("key", JOBS[j].label, s.status, s.lastErr ? `failing: ${s.lastErr}` : s.lastOk ? `last success ${s.lastOk}` : "has not completed a run yet", { lastSuccess: s.lastOk, next: s.next, checked: s.status !== "unknown" });
    }))),
    deps.watchdog && deps.env.WATCHDOG_URLS
      ? fn("key", "Watchdog", deps.watchdog.healthy ? "ok" : "down", deps.watchdog.lastError ?? "healthy", { lastSuccess: deps.watchdog.healthy ? iso : null })
      : fn("key", "Watchdog", "unknown", "off (WATCHDOG_URLS is empty)", { checked: false }),
  ];

  const businesses = await Promise.all(
    deps.businesses.map(async (b) => {
      const paused = await agentPaused(deps, b).catch((err: unknown) => ({ paused: true, why: String(err) }));
      return {
        id: b.id,
        paused,
        lastCallAt: (await deps.store.getFlag(`last-call-at:${b.id}`)) ?? null,
        queuedTextBacks: (await deps.store.listFlags(`deferred-textback:${b.id}|`)).length,
        outcomesToday: await deps.store.outcomesSince(b.id, new Date(now.getTime() - DAY)),
        outcomes7Days: await deps.store.outcomesSince(b.id, week),
        summary: await plainStatus(deps, b, paused, now),
      };
    }),
  );
  const pausedList = businesses.filter((b) => b.paused.paused);
  const functions = [
    ...rows,
    fn("basic", "Kill switch", pausedList.length ? "warning" : "ok", pausedList.length ? pausedList.map((b) => `${b.id} paused: ${b.paused.why}`).join("; ") : "no business is paused"),
    await backupRow(deps, fn, now),
    fn("basic", "Version", "ok", deps.env.APP_VERSION ?? "unknown", { checked: false }),
    fn("basic", "Mode", "ok", `agent=${deps.env.AGENT_MODE}, dryRun=${deps.env.DRY_RUN !== "false"}`, { checked: false }),
  ];
  const overall = functions.filter((f) => f.tier === "important").reduce<St>((w, f) => {
    if (w === "down" || f.status === "ok") return w;
    if (f.status === "down") return "down";
    if (f.status === "warning") return "warning";
    return w === "ok" ? "unknown" : w; // an unchecked Important row keeps overall from reading OK
  }, "ok");
  const latestUpdate = await readFile(new URL("../docs/latest-update.md", import.meta.url), "utf8").catch(() => null);
  return { product: "AI Receptionist", overall, checked_at: iso, functions, businesses, latestUpdate };
}

type Fn = (tier: Tier, name: string, status: St, detail: string, o?: Opts) => Record<string, unknown> & { status: St };

async function calRow(deps: Deps, fn: Fn, now: Date, iso: string) {
  const name = "Cal.com availability";
  const calBiz = deps.businesses.find((b) => b.cal);
  if (!calBiz?.cal) return fn("important", name, "unknown", "no Cal.com event configured (CAL_LINK_*)", { checked: false });
  // The real event's slots, not just any HTTP reply.
  const slots = await openTimes(calBiz.cal, now, new Date(now.getTime() + 7 * DAY), deps.env.CAL_API_KEY, deps.fetch);
  if (slots === null) return fn("important", name, "down", "slots request failed");
  return fn("important", name, slots.length ? "ok" : "warning", `${slots.length} open slots in the next 7 days`, { lastSuccess: slots.length ? iso : null });
}

async function callRows(deps: Deps, fn: Fn, now: Date, week: Date) {
  const calls = (await Promise.all(deps.businesses.map((b) => deps.store.recentCalls(b.id, week)))).flat();
  const failed = calls.filter(callFailed).length;
  const answered = !calls.length
    ? fn("important", "Calls answered", "unknown", "no calls recorded in the last 7 days", { checked: false })
    : fn("important", "Calls answered", failed === 0 ? "ok" : failed * 2 >= calls.length && failed >= 3 ? "down" : "warning", `${calls.length - failed} of ${calls.length} calls ended without a technical error (7 days)`, { lastSuccess: calls.filter((c) => !callFailed(c)).map((c) => c.endedAt).filter(Boolean).sort().at(-1) ?? null });
  const messages = calls.filter((c) => c.message);
  const lost = messages.filter((c) => c.message!.delivered === "none").length;
  const delivered = !messages.length
    ? fn("important", "Messages delivered", "unknown", "no caller messages in the last 7 days", { checked: false })
    : fn("important", "Messages delivered", lost ? "down" : "ok", lost ? `${lost} of ${messages.length} messages saved but not sent to the owner` : `all ${messages.length} messages reached the owner`, { lastSuccess: messages.filter((c) => c.message!.delivered !== "none").map((c) => c.message!.at).sort().at(-1) ?? null });
  const open = (await unfinishedCalls(deps.store, deps.businesses, now)).length;
  const unfinished = fn("important", "Unfinished calls", open ? "warning" : "ok", open ? `${open} calls started over 20 minutes ago have no end-of-call report (the reconcile job will close them)` : "no calls are waiting for a final report");
  const alertFail = await deps.store.getFlag(ALERT_FAILED_KEY);
  const alertOk = await deps.store.getFlag(ALERT_OK_KEY);
  const failedAt = alertFail?.split(" ")[0] ?? "";
  const alerts = alertFail && (!alertOk || failedAt > alertOk)
    ? fn("important", "Owner alerts", "down", `the last time neither text nor email reached the owner: ${alertFail}`, { lastSuccess: alertOk ?? null })
    : alertOk
      ? fn("important", "Owner alerts", "ok", `last owner alert delivered ${alertOk}`, { lastSuccess: alertOk })
      : fn("important", "Owner alerts", "unknown", "no real owner alert has been sent yet", { checked: false });
  return [answered, delivered, unfinished, alerts];
}

/** Twilio and Resend: the recorded result of the last real send. Vapi: when its last report arrived. */
async function integrationRows(deps: Deps, fn: Fn) {
  const rec = async (channel: "sms" | "email", name: string, what: string) => {
    const v = await deps.store.getFlag(sendKey(channel));
    if (!v) return fn("key", name, "unknown", deps.env.DRY_RUN !== "false" ? `dry run: no real ${what} sent` : `no ${what} sent since start`, { checked: false });
    const [at, ...rest] = v.split(" ");
    const ok = rest.join(" ") === "ok";
    return fn("key", name, ok ? "ok" : "down", ok ? `last ${what} sent ${at}` : `last ${what} failed at ${at}: ${rest.join(" ")}`, { lastSuccess: ok ? at! : null });
  };
  const vapi = await deps.store.getFlag("mem:vapi:last-report");
  return [
    await rec("sms", "Twilio (text and voice)", "text"),
    await rec("email", "Resend (email)", "email"),
    vapi ? fn("key", "Vapi (AI calls)", "ok", `last call report received ${vapi}`, { lastSuccess: vapi }) : fn("key", "Vapi (AI calls)", "unknown", "no call report received since start", { checked: false }),
  ];
}

function storageRow(deps: Deps, fn: Fn, iso: string) {
  if (!deps.env.STATE_FILE) return fn("important", "State storage", "warning", "STATE_FILE not set: state is lost on restart");
  const err = deps.store.lastPersistError;
  return fn("important", "State storage", err ? "down" : "ok", err ?? `writing to ${deps.env.STATE_FILE}`, { lastSuccess: err ? null : iso });
}

/** Latest backup: the time of `<STATE_FILE>.backup` (touched by the host's snapshot job). Unknown until one can be read. */
async function backupRow(deps: Deps, fn: Fn, now: Date) {
  const file = deps.env.STATE_FILE ? `${deps.env.STATE_FILE}.backup` : "";
  const s = file ? await stat(file).catch(() => null) : null;
  if (!s) return fn("basic", "Latest backup", "unknown", "no backup time can be read yet (see the README, Backups)", { checked: false });
  const age = now.getTime() - s.mtimeMs;
  return fn("basic", "Latest backup", age > 2 * DAY ? "warning" : "ok", `last backup ${new Date(s.mtimeMs).toISOString()}`, { lastSuccess: new Date(s.mtimeMs).toISOString() });
}
