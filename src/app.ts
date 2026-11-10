import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { validTwilioSignature } from "./twilio/signature.js";
import * as twilio from "./twilio/routes.js";
import { agentPaused } from "./safety/killswitch.js";
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
    const fn = (name: string, status: St, detail: string, lastSuccess: string | null = null, nextExpected: string | null = null) =>
      ({ name, status, detail, last_checked: iso, last_success: lastSuccess, next_expected_run: nextExpected });

    // Cal.com: the real event's slots, not just any HTTP reply.
    const calBiz = deps.businesses.find((b) => b.cal);
    let cal = fn("Cal.com availability", "unknown", "no Cal.com event configured (CAL_LINK_*)");
    if (calBiz?.cal) {
      const slots = await openTimes(calBiz.cal, now, new Date(now.getTime() + 7 * 86_400_000), deps.env.CAL_API_KEY, deps.fetch);
      cal = slots === null ? fn("Cal.com availability", "down", "slots request failed") : fn("Cal.com availability", slots.length ? "ok" : "warning", `${slots.length} open slots in the next 7 days`, slots.length ? iso : null);
    }
    const lastFlush = (await deps.store.getFlag("flush-last-run")) ?? null;
    const flushAge = lastFlush ? now.getTime() - new Date(lastFlush).getTime() : Infinity;
    const flush = fn("Deferred text-back job", lastFlush ? (flushAge < 180_000 ? "ok" : "down") : "unknown", lastFlush ? `last run ${lastFlush}` : "has not run yet (or not started by server)", lastFlush, lastFlush ? new Date(new Date(lastFlush).getTime() + 60_000).toISOString() : null);
    const wd = deps.watchdog && deps.env.WATCHDOG_URLS ? fn("Watchdog", deps.watchdog.healthy ? "ok" : "down", deps.watchdog.lastError ?? "healthy", deps.watchdog.healthy ? iso : null) : fn("Watchdog", "unknown", "off (WATCHDOG_URLS is empty)");
    const disk = deps.env.STATE_FILE ? fn("State storage", deps.store.lastPersistError ? "down" : "ok", deps.store.lastPersistError ?? `writing to ${deps.env.STATE_FILE}`, deps.store.lastPersistError ? null : iso) : fn("State storage", "warning", "STATE_FILE not set: state is lost on restart");
    const cfgMissing = missingConfig();
    const config = fn("Live configuration", cfgMissing.length ? (deps.env.DRY_RUN === "false" ? "down" : "warning") : "ok", cfgMissing.length ? `missing: ${cfgMissing.join(", ")}` : "all present", cfgMissing.length ? null : iso);

    const businesses = await Promise.all(
      deps.businesses.map(async (b) => {
        const paused = await agentPaused(deps, b).catch((err: unknown) => ({ paused: true, why: String(err) }));
        return {
          id: b.id,
          paused,
          lastCallAt: (await deps.store.getFlag(`last-call-at:${b.id}`)) ?? null,
          queuedTextBacks: (await deps.store.listFlags(`deferred-textback:${b.id}|`)).length,
          outcomesToday: await deps.store.outcomesSince(b.id, new Date(now.getTime() - 86_400_000)),
          outcomes7Days: await deps.store.outcomesSince(b.id, new Date(now.getTime() - 7 * 86_400_000)),
        };
      }),
    );
    const important = [disk, config, cal];
    const key = [flush, wd];
    const basic = [
      fn("Version", "ok", deps.env.APP_VERSION ?? "unknown", iso),
      fn("Mode", "ok", `agent=${deps.env.AGENT_MODE}, dryRun=${deps.env.DRY_RUN !== "false"}, killSwitch=${deps.env.KILL_SWITCH}`, iso),
    ];
    const rank: Record<St, number> = { ok: 0, unknown: 1, warning: 2, down: 3 };
    const overall = [...important, ...key].reduce<St>((w, f) => (rank[f.status] > rank[w] ? f.status : w), "ok");
    const latestUpdate = await readFile(new URL("../docs/latest-update.md", import.meta.url), "utf8").catch(() => null);
    return c.json({ status: overall, last_checked: iso, important, key, basic, businesses, latestUpdate });
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
