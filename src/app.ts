import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { validTwilioSignature } from "./twilio/signature.js";
import * as twilio from "./twilio/routes.js";
import { agentPaused } from "./safety/killswitch.js";
import { callFailed, JOBS, jobState, plainStatus, type JobName } from "./status.js";
import { openTimes } from "./tools/calcom.js";
import { handleVapi, type Deps } from "./vapi/handler.js";

function sameSecret(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();
  const isAdmin = (header: string | undefined) => Boolean(deps.env.ADMIN_SECRET) && sameSecret(header?.replace(/^Bearer /, "") ?? "", deps.env.ADMIN_SECRET);

  // Config the service can't safely run live without. Only enforced when DRY_RUN=false.
  const missingConfig = () => {
    const miss: string[] = [];
    if (!deps.env.VAPI_SECRET) miss.push("VAPI_SECRET");
    if (!deps.env.TWILIO_AUTH_TOKEN || !deps.env.TWILIO_ACCOUNT_SID) miss.push("TWILIO_*");
    if (!deps.env.RESEND_API_KEY) miss.push("RESEND_API_KEY");
    if (!deps.env.STATE_FILE) miss.push("STATE_FILE");
    for (const b of deps.businesses) if (!b.ownerEmail) miss.push(`owner email (${b.id})`);
    return miss;
  };

  app.get("/health", (c) => {
    const dryRun = deps.env.DRY_RUN !== "false";
    const missing = dryRun ? [] : missingConfig();
    return c.json({ ok: missing.length === 0, dryRun, missing, version: deps.env.APP_VERSION }, missing.length ? 503 : 200);
  });

  // Owner/operator status in the standard tiered shape: real checks, behind ADMIN_SECRET.
  app.get("/admin/status.json", async (c) => {
    if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    const now = deps.now?.() ?? new Date();
    const iso = now.toISOString();
    type St = "ok" | "warning" | "down" | "unknown";
    type Tier = "important" | "key" | "basic";
    // last_checked is set only for rows actually evaluated from a recorded result now; null otherwise.
    const fn = (tier: Tier, name: string, status: St, detail: string, o: { checked?: boolean; lastSuccess?: string | null; next?: string | null } = {}) =>
      ({ name, tier, status, detail, last_checked: o.checked === false ? null : iso, last_success: o.lastSuccess ?? null, next_expected_run: o.next ?? null });
    const week = new Date(now.getTime() - 7 * 86_400_000);

    // Cal.com: the real event's slots, not just any HTTP reply.
    const calBiz = deps.businesses.find((b) => b.cal);
    let cal = fn("important", "Cal.com availability", "unknown", "no Cal.com event configured (CAL_LINK_*)", { checked: false });
    if (calBiz?.cal) {
      const slots = await openTimes(calBiz.cal, now, new Date(now.getTime() + 7 * 86_400_000), deps.env.CAL_API_KEY, deps.fetch);
      cal = slots === null ? fn("important", "Cal.com availability", "down", "slots request failed") : fn("important", "Cal.com availability", slots.length ? "ok" : "warning", `${slots.length} open slots in the next 7 days`, { lastSuccess: slots.length ? iso : null });
    }
    // Recorded results: how calls ended and whether messages reached the owner (last 7 days, all businesses).
    const calls = (await Promise.all(deps.businesses.map((b) => deps.store.recentCalls(b.id, week)))).flat();
    const failedCalls = calls.filter(callFailed).length;
    const answered = !calls.length
      ? fn("important", "Calls answered", "unknown", "no calls recorded in the last 7 days", { checked: false })
      : fn("important", "Calls answered", failedCalls === 0 ? "ok" : failedCalls * 2 >= calls.length && failedCalls >= 3 ? "down" : "warning", `${calls.length - failedCalls} of ${calls.length} calls ended without a technical error (7 days)`, { lastSuccess: calls.filter((c) => !callFailed(c)).map((c) => c.endedAt).filter(Boolean).sort().at(-1) ?? null });
    const messages = calls.filter((c) => c.message);
    const undelivered = messages.filter((c) => c.message!.delivered === "none").length;
    const delivered = !messages.length
      ? fn("important", "Messages delivered", "unknown", "no caller messages in the last 7 days", { checked: false })
      : fn("important", "Messages delivered", undelivered ? "down" : "ok", undelivered ? `${undelivered} of ${messages.length} messages saved but not sent to the owner` : `all ${messages.length} messages reached the owner`, { lastSuccess: messages.filter((c) => c.message!.delivered !== "none").map((c) => c.message!.at).sort().at(-1) ?? null });

    const jobRows = await Promise.all((Object.keys(JOBS) as JobName[]).map(async (j) => {
      const s = await jobState(deps.store, j, now);
      return fn("key", JOBS[j].label, s.status, s.lastErr ? `failing: ${s.lastErr}` : s.lastOk ? `last success ${s.lastOk}` : "has not completed a run yet", { lastSuccess: s.lastOk, next: s.next, checked: s.status !== "unknown" });
    }));
    const wd = deps.watchdog && deps.env.WATCHDOG_URLS ? fn("key", "Watchdog", deps.watchdog.healthy ? "ok" : "down", deps.watchdog.lastError ?? "healthy", { lastSuccess: deps.watchdog.healthy ? iso : null }) : fn("key", "Watchdog", "unknown", "off (WATCHDOG_URLS is empty)", { checked: false });
    const disk = deps.env.STATE_FILE ? fn("important", "State storage", deps.store.lastPersistError ? "down" : "ok", deps.store.lastPersistError ?? `writing to ${deps.env.STATE_FILE}`, { lastSuccess: deps.store.lastPersistError ? null : iso }) : fn("important", "State storage", "warning", "STATE_FILE not set: state is lost on restart");
    const cfgMissing = missingConfig();
    const config = fn("important", "Live configuration", cfgMissing.length ? (deps.env.DRY_RUN === "false" ? "down" : "warning") : "ok", cfgMissing.length ? `missing: ${cfgMissing.join(", ")}` : "all present", { lastSuccess: cfgMissing.length ? null : iso });

    const businesses = await Promise.all(
      deps.businesses.map(async (b) => {
        const paused = await agentPaused(deps, b).catch((err: unknown) => ({ paused: true, why: String(err) }));
        return {
          id: b.id,
          paused,
          lastCallAt: (await deps.store.getFlag(`last-call-at:${b.id}`)) ?? null,
          queuedTextBacks: (await deps.store.listFlags(`deferred-textback:${b.id}|`)).length,
          outcomesToday: await deps.store.outcomesSince(b.id, new Date(now.getTime() - 86_400_000)),
          outcomes7Days: await deps.store.outcomesSince(b.id, week),
          summary: await plainStatus(deps, b, paused, now),
        };
      }),
    );
    const functions = [
      answered, delivered, cal, disk, config,
      ...jobRows, wd,
      fn("basic", "Version", "ok", deps.env.APP_VERSION ?? "unknown", { checked: false }),
      fn("basic", "Mode", "ok", `agent=${deps.env.AGENT_MODE}, dryRun=${deps.env.DRY_RUN !== "false"}, killSwitch=${deps.env.KILL_SWITCH}`, { checked: false }),
    ];
    // Overall counts Important rows only; unknown rows don't change it.
    const overall = functions.filter((f) => f.tier === "important" && f.status !== "unknown").reduce<St>((w, f) => (f.status === "down" || (f.status === "warning" && w === "ok") ? f.status : w), "ok");
    const latestUpdate = await readFile(new URL("../docs/latest-update.md", import.meta.url), "utf8").catch(() => null);
    return c.json({ overall, checked_at: iso, functions, businesses, latestUpdate });
  });

  // Public legal documents (linked from the text-back and the 10DLC registration).
  for (const [path, file] of [["/privacy", "privacy.md"], ["/terms", "terms.md"]] as const) {
    app.get(path, async (c) => {
      const text = await readFile(new URL(`../docs/legal/${file}`, import.meta.url), "utf8").catch(() => null);
      return text ? c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" }) : c.text("not found", 404);
    });
  }

  // Vapi server messages. Every request must carry VAPI_SECRET; with DRY_RUN=false and no secret set, all are refused.
  app.post("/vapi", async (c) => {
    if (!deps.env.VAPI_SECRET && deps.env.DRY_RUN === "false") {
      // Fail closed: never accept unauthenticated tool calls once real texts and bookings can go out.
      return c.json({ error: "VAPI_SECRET not configured" }, 503);
    }
    if (deps.env.VAPI_SECRET && !sameSecret(deps.env.VAPI_SECRET, c.req.header("x-vapi-secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    return c.json(await handleVapi(deps, body));
  });

  // Operator tools for access, correction and deletion requests, by phone number.
  for (const action of ["export", "delete"] as const) {
    app.post(`/admin/${action}`, async (c) => {
      if (!isAdmin(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      const body = (await c.req.json().catch(() => null)) as { phone?: string } | null;
      if (!body?.phone || !/^\+\d{8,15}$/.test(body.phone)) return c.json({ error: "phone must be E.164, e.g. +14805551234" }, 400);
      if (action === "export") return c.json(await deps.store.exportNumber(body.phone));
      return c.json({ deleted: await deps.store.deleteNumber(body.phone), note: "Also delete in Vapi, Cal.com and Twilio logs; see docs/legal/data-inventory.md" });
    });
  }

  // Twilio webhooks: form-encoded, signed with the account's auth token.
  const twilioRoute = (path: string, handler: (p: twilio.Params) => Promise<string | void>) =>
    app.post(path, async (c) => {
      const form = await c.req.parseBody();
      const params: twilio.Params = {};
      for (const [k, v] of Object.entries(form)) if (typeof v === "string") params[k] = v;
      const url = `${deps.env.PUBLIC_URL}${path}`;
      if (deps.env.TWILIO_AUTH_TOKEN) {
        if (!validTwilioSignature(deps.env.TWILIO_AUTH_TOKEN, url, params, c.req.header("x-twilio-signature"))) {
          return c.text("forbidden", 403);
        }
      } else if (deps.env.DRY_RUN === "false") {
        // Never accept unsigned Twilio requests once real messages can go out.
        return c.text("Twilio auth token not configured", 503);
      }
      const out = await handler(params);
      return out ? c.body(out, 200, { "Content-Type": "text/xml" }) : c.body(null, 204);
    });

  twilioRoute("/twilio/voice", (p) => twilio.voice(deps, p));
  twilioRoute("/twilio/dial-result", (p) => twilio.dialResult(deps, p));
  twilioRoute("/twilio/status", (p) => twilio.status(deps, p));
  twilioRoute("/twilio/sms", (p) => twilio.sms(deps, p));

  return app;
}
