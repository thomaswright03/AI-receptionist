import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadBusinesses } from "../src/config/businesses.js";
import { loadEnv } from "../src/config/env.js";
import { getFlow } from "../src/flows/index.js";
import { notifier, recordingNotifier, type Notifier, type Sent } from "../src/notify.js";
import { reconcileUnfinishedCalls } from "../src/reconcile.js";
import { memoryStore } from "../src/store.js";
import { sendWeeklySummaries } from "../src/summary.js";
import { flushDeferredTextBacks, missedCallTextBack } from "../src/textBack.js";
import { buildAssistant, buildStubAssistant, systemPrompt } from "../src/vapi/assistant.js";
import { handleVapi, needsTextBack, type Deps } from "../src/vapi/handler.js";

const NUMBER = "+16025550100";
const OWNER = "+16025550199";
const CALLER = "+14805550123";
const TUE_10AM = new Date("2026-11-10T17:00:00Z");
const TUE_11PM = new Date("2026-11-11T06:00:00Z");

function make(opts: { env?: Record<string, string>; failSms?: boolean; failEmail?: boolean; now?: Date } = {}) {
  const env = loadEnv({ WRIGHT_AI_NUMBER: NUMBER, OWNER_PHONE_WRIGHT_AI: OWNER, OWNER_EMAIL_WRIGHT_AI: "o@example.com", PUBLIC_URL: "https://r.example.com", ADMIN_SECRET: "s", ...opts.env });
  const sent: Sent[] = [];
  const notify: Notifier = {
    async sms(to, from, body) { const s = { channel: "sms" as const, to, from, body, dryRun: false, ok: !opts.failSms, error: opts.failSms ? "Twilio 500" : undefined }; sent.push(s); return s; },
    async email(to, subject, body) { const s = { channel: "email" as const, to, subject, body, dryRun: false, ok: !opts.failEmail, error: opts.failEmail ? "Resend 500" : undefined }; sent.push(s); return s; },
  };
  const store = memoryStore();
  const deps: Deps = { env, businesses: loadBusinesses(env), store, notify, now: () => opts.now ?? TUE_10AM, fetch: (async () => { throw new Error("no network"); }) as typeof fetch };
  return { deps, sent, store, env };
}
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const ownersEmails = (sent: Sent[]) => sent.filter((s) => s.channel === "email");
const ownerSms = (sent: Sent[]) => sent.filter((s) => s.channel === "sms" && s.to === OWNER);

describe("1: unanswered transfer", () => {
  it("assistant config has a fallback plan that takes a message", () => {
    const { deps } = make();
    const a = buildAssistant(deps.env, deps.businesses[0]!, getFlow("discovery-call"), { now: TUE_10AM, openTimes: [], canTransfer: true }) as any;
    const t = a.model.tools.find((x: any) => x.type === "transferCall");
    expect(t.destinations[0].transferPlan.fallbackPlan.endCallEnabled).toBe(false);
    expect(a.model.messages[0].content).toContain("transfer to the owner is not answered");
    expect(JSON.stringify(buildStubAssistant(deps.env, deps.businesses[0]!, { canTransfer: true, now: TUE_10AM }))).toContain("not answered");
  });
  it("an unanswered transfer in the end-of-call report is a missed call, not 'transferred'", async () => {
    const { deps, sent, store } = make();
    const call = { id: "c1", customer: { number: CALLER }, phoneNumber: { number: NUMBER } };
    await handleVapi(deps, { message: { type: "assistant-request", call } });
    await handleVapi(deps, { message: { type: "end-of-call-report", call, endedReason: "call.forwarding.operator-busy", artifact: { messages: [{ role: "user" }] } } });
    expect((await store.getCall("c1"))?.outcome).toBe("text-back");
    expect(sent.some((s) => s.to === OWNER && s.body.includes("transfer to the owner was not answered"))).toBe(true);
    expect(sent.some((s) => s.to === CALLER)).toBe(true);
  });
  it("an answered transfer is still 'transferred'", async () => {
    const { deps, store } = make();
    const call = { id: "c2", customer: { number: CALLER }, phoneNumber: { number: NUMBER } };
    await handleVapi(deps, { message: { type: "assistant-request", call } });
    await handleVapi(deps, { message: { type: "end-of-call-report", call, endedReason: "assistant-forwarded-call" } });
    expect((await store.getCall("c2"))?.outcome).toBe("transferred");
    expect(needsTextBack("assistant-forwarded-call", 3, "unknown")).toBe(false);
  });
});

describe("2: missed-call owner notice falls back to email", () => {
  it("no owner phone: one owner email on a Twilio no-answer status callback", async () => {
    const { deps, sent } = make({ env: { OWNER_PHONE_WRIGHT_AI: "" } });
    const r = await createApp(deps).request("/twilio/status", form({ To: NUMBER, From: CALLER, CallStatus: "no-answer" }));
    expect(r.status).toBeLessThan(300);
    const mail = ownersEmails(sent).filter((s) => s.to === "o@example.com");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.body).toContain(CALLER);
  });
  it("SMS failing: the email goes out; both failing is shown on the status endpoint", async () => {
    const a = make({ failSms: true });
    await missedCallTextBack({ store: a.store, notify: a.deps.notify, now: TUE_10AM }, a.deps.businesses[0]!, CALLER, "no-answer");
    expect(ownersEmails(a.sent).some((s) => s.to === "o@example.com")).toBe(true);
    const b = make({ failSms: true, failEmail: true });
    await missedCallTextBack({ store: b.store, notify: b.deps.notify, now: TUE_10AM }, b.deps.businesses[0]!, CALLER, "no-answer");
    const status = (await (await createApp(b.deps).request("/admin/status.json", { headers: { authorization: "Bearer s" } })).json()) as any;
    expect(status.functions.find((f: any) => f.name === "Owner alerts").status).toBe("down");
  });
});

describe("3: lost end-of-call report", () => {
  it("closes a 30-minute-old call once: one text-back, one owner alert, second run does nothing", async () => {
    const { deps, sent, store } = make({ now: new Date(TUE_10AM.getTime() + 30 * 60_000) });
    await store.saveCall({ callId: "old", businessId: "wright-ai", caller: CALLER, startedAt: TUE_10AM.toISOString(), outcome: "unknown" });
    await store.saveCall({ callId: "fresh", businessId: "wright-ai", caller: "+14805550999", startedAt: new Date(TUE_10AM.getTime() + 25 * 60_000).toISOString(), outcome: "unknown" });
    const d = { store, notify: deps.notify, now: deps.now };
    expect(await reconcileUnfinishedCalls(d, deps.businesses)).toBe(1);
    expect(await reconcileUnfinishedCalls(d, deps.businesses)).toBe(0);
    const closed = await store.getCall("old");
    expect(closed?.endedAt).toBeTruthy();
    expect(closed?.outcome).toBe("text-back");
    expect(sent.filter((s) => s.to === CALLER)).toHaveLength(1);
    expect(ownerSms(sent)).toHaveLength(1);
    expect((await store.getCall("fresh"))?.endedAt).toBeUndefined();
  });
  it("a booked call with no report is closed without a text-back; the status shows the unfinished count", async () => {
    const { deps, sent, store } = make({ now: new Date(TUE_10AM.getTime() + 30 * 60_000) });
    await store.saveCall({ callId: "b", businessId: "wright-ai", caller: CALLER, startedAt: TUE_10AM.toISOString(), outcome: "booked" });
    const row = async () => ((await (await createApp(deps).request("/admin/status.json", { headers: { authorization: "Bearer s" } })).json()) as any).functions;
    expect((await row()).find((f: any) => f.name === "Unfinished calls").status).toBe("warning");
    expect(await reconcileUnfinishedCalls({ store, notify: deps.notify, now: deps.now }, deps.businesses)).toBe(1);
    expect(sent).toHaveLength(0);
    const fns = await row();
    expect(fns.find((f: any) => f.name === "Unfinished calls").status).toBe("ok");
    expect(fns.some((f: any) => f.name === "Lost call report job")).toBe(true);
  });
});

describe("5: status rows", () => {
  const get = async (deps: Deps) => ((await (await createApp(deps).request("/admin/status.json", { headers: { authorization: "Bearer s" } })).json()) as any).functions as any[];
  it("KILL_SWITCH=on shows a Kill switch warning with the reason", async () => {
    const { deps } = make({ env: { KILL_SWITCH: "on" } });
    const row = (await get(deps)).find((f) => f.name === "Kill switch");
    expect(row.status).toBe("warning");
    expect(row.detail).toContain("KILL_SWITCH=on");
  });
  it("Twilio row is Unknown until checked, Down after a failed send; Backup is Unknown", async () => {
    const { deps, store } = make({ failSms: true });
    expect((await get(deps)).find((f) => f.name.startsWith("Twilio")).status).toBe("unknown");
    deps.notify = recordingNotifier(deps.notify, store);
    await deps.notify.sms(OWNER, NUMBER, "x");
    await new Promise((r) => setTimeout(r, 5));
    const fns = await get(deps);
    expect(fns.find((f) => f.name.startsWith("Twilio")).status).toBe("down");
    expect(fns.find((f) => f.name.startsWith("Resend")).status).toBe("unknown");
    expect(fns.find((f) => f.name === "Latest backup").status).toBe("unknown");
    expect(fns.find((f) => f.name.startsWith("Vapi")).status).toBe("unknown");
  });
  it("dry-run sends are not recorded as real ones", async () => {
    const { deps, store } = make();
    const n = recordingNotifier(notifier(deps.env), store);
    await n.email("a@b.c", "s", "b");
    expect(await store.getFlag("mem:send:email")).toBeUndefined();
  });
});

describe("6 and 7: texting window and owner SMS count", () => {
  it("an 808 missed call is not queued and the owner is told honestly", async () => {
    const { deps, sent, store } = make();
    const r = await missedCallTextBack({ store, notify: deps.notify, now: TUE_10AM }, deps.businesses[0]!, "+18085550123", "no-answer");
    expect(r.sent).toBe(false);
    expect(await store.listFlags("deferred-textback:")).toEqual([]);
    expect(ownerSms(sent)[0]!.body).toContain("Hawaii or Alaska");
  });
  it("a queued after-hours text-back costs the owner one SMS; the send-time notice is an email", async () => {
    const { deps, sent, store } = make();
    await missedCallTextBack({ store, notify: deps.notify, now: TUE_11PM }, deps.businesses[0]!, CALLER, "no-answer");
    const next = new Date(TUE_11PM.getTime() + 15 * 3600_000);
    expect(await flushDeferredTextBacks({ store, notify: deps.notify, now: () => next }, deps.businesses)).toBe(1);
    expect(ownerSms(sent)).toHaveLength(1);
    expect(ownerSms(sent)[0]!.body).toContain("within 24 hours");
    expect(sent.filter((s) => s.to === CALLER)).toHaveLength(1);
    expect(ownersEmails(sent)).toHaveLength(1);
  });
  it("an entry that expires unsent is reported to the owner by email", async () => {
    const { deps, sent, store } = make();
    await missedCallTextBack({ store, notify: deps.notify, now: TUE_11PM }, deps.businesses[0]!, CALLER, "no-answer");
    await flushDeferredTextBacks({ store, notify: deps.notify, now: () => new Date(TUE_11PM.getTime() + 25 * 3600_000) }, deps.businesses);
    expect(ownersEmails(sent)[0]!.body).toContain("dropped");
  });
});

describe("9: owner HELP, STOP and guide", () => {
  it("HELP from the owner gets the command list and is not forwarded", async () => {
    const { deps, sent } = make();
    const r = await createApp(deps).request("/twilio/sms", form({ To: NUMBER, From: OWNER, Body: "help" }));
    const text = await r.text();
    expect(text).toContain("PAUSE");
    expect(text).toContain("STATUS");
    expect(sent).toHaveLength(0);
  });
  it("owner STOP is a command with a warning and does not opt the owner out", async () => {
    const { deps, store } = make();
    const text = await (await createApp(deps).request("/twilio/sms", form({ To: NUMBER, From: OWNER, Body: "STOP" }))).text();
    expect(text).toContain("alerts keep coming");
    expect(await store.isOptedOut(OWNER)).toBe(false);
  });
  it("the owner guide goes with the first weekly summary only", async () => {
    const monday = new Date("2026-11-16T17:00:00Z");
    const { deps, sent, store } = make({ now: monday });
    await sendWeeklySummaries({ store, notify: deps.notify, now: () => monday }, deps.businesses);
    expect(ownersEmails(sent)[0]!.body).toContain("owner guide");
    const next = new Date(monday.getTime() + 7 * 86_400_000);
    await sendWeeklySummaries({ store, notify: deps.notify, now: () => next }, deps.businesses);
    expect(ownersEmails(sent)[1]!.body).not.toContain("owner guide");
  });
});

describe("10 and 17: prompt wording", () => {
  it("says 'by email' when there is no owner phone, 'by text' otherwise", () => {
    const { deps } = make({ env: { OWNER_PHONE_WRIGHT_AI: "" } });
    const b = deps.businesses[0]!;
    const p = systemPrompt(b, getFlow(b.flowId), { now: TUE_10AM, openTimes: [], canTransfer: false });
    expect(p).toContain("confirm by email");
    expect(p).not.toContain("confirm by text");
    const q = systemPrompt({ ...b, ownerPhone: OWNER }, getFlow(b.flowId), { now: TUE_10AM, openTimes: [], canTransfer: false });
    expect(q).toContain("confirm by text");
  });
  it("a caller with no email is a routine message, not urgent", () => {
    const { deps } = make();
    const b = deps.businesses[0]!;
    expect(systemPrompt(b, getFlow(b.flowId), { now: TUE_10AM, openTimes: [], canTransfer: false })).toContain("take_message instead (urgent: false");
  });
});

describe("11: Mountain High", () => {
  it("is absent without its number; with it, routes its number and builds a message-taking assistant", async () => {
    expect(make().deps.businesses.map((b) => b.id)).toEqual(["wright-ai"]);
    const { deps } = make({ env: { MOUNTAIN_HIGH_NUMBER: "+16025550111", OWNER_EMAIL_MOUNTAIN_HIGH: "mh@example.com" } });
    expect(deps.businesses.map((b) => b.id)).toEqual(["wright-ai", "mountain-high"]);
    const call = { id: "m1", customer: { number: CALLER }, phoneNumber: { number: "+16025550111" } };
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as any;
    expect(out.assistant.name).toBe("mountain-high-roll-off");
    const tools = out.assistant.model.tools.map((t: any) => t.function?.name ?? t.type);
    expect(tools).toContain("take_message");
    expect(tools).not.toContain("book_discovery_call");
    expect(out.assistant.model.messages[0].content).toContain("Mountain High Disposal");
    expect((await deps.store.getCall("m1"))?.businessId).toBe("mountain-high");
  });
});

describe("round 5", () => {
  it("lost report with a hidden number is recorded as missed, not text-back", async () => {
    const { deps, store } = make();
    const start = new Date(TUE_10AM.getTime() - 60 * 60_000);
    await store.saveCall({ callId: "c1", businessId: deps.businesses[0]!.id, caller: "anonymous", startedAt: start.toISOString(), outcome: "unknown" });
    await reconcileUnfinishedCalls({ store, notify: deps.notify, now: () => TUE_10AM }, deps.businesses);
    expect((await store.getCall("c1"))!.outcome).toBe("missed");
  });
  it("twilio no-answer is recorded as a call", async () => {
    const { deps, store } = make();
    const app = createApp(deps);
    await app.request("/twilio/dial-result", form({ To: NUMBER, From: CALLER, CallSid: "CA1", DialCallStatus: "no-answer" }));
    const o = await store.outcomesSince(deps.businesses[0]!.id, new Date(TUE_10AM.getTime() - 86_400_000));
    expect((o["missed"] ?? 0) + (o["text-back"] ?? 0)).toBe(1);
  });
  it("fresh store: Owner alerts unknown and overall not ok", async () => {
    const { deps } = make();
    const { buildStatus } = await import("../src/statusJson.js");
    const s: any = await buildStatus(deps, [], TUE_10AM);
    expect(s.functions.find((f: any) => f.name === "Owner alerts").status).toBe("unknown");
    expect(s.overall).not.toBe("ok");
    expect(s.product).toBeTruthy();
  });
  it("over-cap call uses an assistant with a transfer fallback and records the call", async () => {
    const { deps, store } = make();
    const biz = deps.businesses[0]!;
    for (let i = 0; i < biz.caps.callsPerDay; i++) await store.recordEvent(biz.id, "call", CALLER, TUE_10AM);
    const r: any = await handleVapi(deps, { message: { type: "assistant-request", call: { id: "cap1", customer: { number: CALLER }, phoneNumber: { number: NUMBER } } } } as any);
    expect(r.assistant).toBeTruthy();
    expect(await store.getCall("cap1")).toBeTruthy();
  });
});
