import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadBusinesses, parseCalLink } from "../src/config/businesses.js";
import { loadEnv } from "../src/config/env.js";
import type { Notifier, Sent } from "../src/notify.js";
import { withinHours } from "../src/safety/hours.js";
import { memoryStore } from "../src/store.js";
import { flushDeferredTextBacks, missedCallTextBack } from "../src/textBack.js";
import { twilioSignature, validTwilioSignature } from "../src/twilio/signature.js";
import { handleVapi, needsTextBack, type Deps } from "../src/vapi/handler.js";
import { Watchdog, watchdogTick } from "../src/safety/watchdog.js";

const NUMBER = "+16025550100";
const OWNER = "+16025550199";
const CALLER = "+14805550123";
// Tuesday 2026-11-10, 10:00 in Phoenix (UTC-7, no daylight saving).
const TUESDAY_10AM = new Date("2026-11-10T17:00:00Z");
const TUESDAY_11PM = new Date("2026-11-11T06:00:00Z");

function fakeNotify() {
  const sent: Sent[] = [];
  const notify: Notifier = {
    async sms(to, from, body) {
      const s = { channel: "sms" as const, to, from, body, dryRun: true, ok: true };
      sent.push(s);
      return s;
    },
    async email(to, subject, body) {
      const s = { channel: "email" as const, to, subject, body, dryRun: true, ok: true };
      sent.push(s);
      return s;
    },
  };
  return { notify, sent };
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

function fakeFetch(routes: Route[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const slots: Route = (url) =>
  url.includes("/v2/slots")
    ? Response.json({ data: { "2026-11-11": [{ start: "2026-11-11T21:00:00.000Z" }, { start: "2026-11-11T22:00:00.000Z" }] } })
    : undefined;

function setup(opts: { now?: Date; routes?: Route[]; env?: Record<string, string> } = {}) {
  const env = loadEnv({
    WRIGHT_AI_NUMBER: NUMBER,
    OWNER_PHONE_WRIGHT_AI: OWNER,
    OWNER_EMAIL_WRIGHT_AI: "owner@example.com",
    CAL_LINK_WRIGHT_AI: "https://cal.com/thomas/phone-call",
    PUBLIC_URL: "https://receptionist.example.com",
    ...opts.env,
  });
  const { notify, sent } = fakeNotify();
  const store = memoryStore();
  const deps: Deps = {
    env,
    businesses: loadBusinesses(env),
    store,
    notify,
    fetch: fakeFetch([slots, ...(opts.routes ?? [])]),
    now: () => opts.now ?? TUESDAY_10AM,
  };
  return { deps, sent, store };
}

const call = { id: "call-1", customer: { number: CALLER }, phoneNumber: { number: NUMBER } };

describe("config", () => {
  it("accepts only real Cal.com event links", () => {
    expect(parseCalLink("https://cal.com/thomas/phone-call")).toEqual({ username: "thomas", slug: "phone-call" });
    expect(parseCalLink("https://evil.com/thomas/phone-call")).toBeUndefined();
    expect(parseCalLink("https://cal.com/thomas")).toBeUndefined();
  });
});

describe("hours", () => {
  const weekdays = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
  it("uses the business's local time", () => {
    expect(withinHours(weekdays, TUESDAY_10AM, "America/Phoenix")).toBe(true);
    expect(withinHours(weekdays, TUESDAY_11PM, "America/Phoenix")).toBe(false);
  });
});

describe("twilio signature", () => {
  it("accepts a correctly signed request and rejects a tampered one", () => {
    const params = { From: CALLER, To: NUMBER, CallStatus: "no-answer" };
    const sig = twilioSignature("token", "https://x.test/twilio/status", params);
    expect(validTwilioSignature("token", "https://x.test/twilio/status", params, sig)).toBe(true);
    expect(validTwilioSignature("token", "https://x.test/twilio/status", { ...params, From: "+1999" }, sig)).toBe(false);
    expect(validTwilioSignature("token", "https://x.test/twilio/status", params, undefined)).toBe(false);
  });
});

describe("assistant-request", () => {
  it("loads open times into the prompt and allows transfer in transfer hours", async () => {
    const { deps } = setup();
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    const prompt: string = out.assistant.model.messages[0].content;
    expect(prompt).toContain("Wednesday, November 11 at 2:00 PM");
    expect(out.assistant.firstMessage).toMatch(/AI assistant.*recorded/);
    const types = out.assistant.model.tools.map((t: any) => t.type === "function" ? t.function.name : t.type);
    expect(types).toEqual(["book_discovery_call", "take_message", "transferCall", "endCall"]);
  });

  it("states AI and recording in the very first sentence", async () => {
    const { deps } = setup();
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    expect(out.assistant.firstMessage.split(",")[0]).toBe("This is Ava");
    expect(out.assistant.firstMessage).toMatch(/^This is Ava, an AI assistant for Wright AI Solutions, and this call is recorded\./);
  });

  it("lists the transfer rules and transfers without a confirming question", async () => {
    const { deps } = setup();
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    const prompt: string = out.assistant.model.messages[0].content;
    expect(prompt).toContain("with no confirming question");
    for (const t of ["billing dispute", "legal threat", "Spanish", "franchise"]) expect(prompt).toContain(t);
  });

  it("week-1 stub only discloses and hands off", async () => {
    const { deps } = setup({ env: { AGENT_MODE: "stub" } });
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    expect(out.assistant.model.messages[0].content).toMatch(/test mode.*transfer the call right away/);
    expect(out.assistant.model.tools.some((t: any) => t.function?.name === "book_discovery_call")).toBe(false);
    expect(out.assistant.model.tools.some((t: any) => t.type === "transferCall")).toBe(true);
  });

  it("takes messages instead of transferring outside transfer hours", async () => {
    const { deps } = setup({ now: TUESDAY_11PM });
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    expect(out.assistant.model.tools.some((t: any) => t.type === "transferCall")).toBe(false);
    expect(out.assistant.model.messages[0].content).toContain("The owner is not available right now");
  });

  it("does not offer booking when the calendar can't be reached", async () => {
    const { deps } = setup();
    deps.fetch = fakeFetch([(u) => (u.includes("/v2/slots") ? new Response("down", { status: 500 }) : undefined)]);
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    expect(out.assistant.model.tools.some((t: any) => t.function?.name === "book_discovery_call")).toBe(false);
    expect(out.assistant.model.messages[0].content).toContain("calendar could not be loaded");
  });

  it("hands the call to the owner once the daily call cap is hit", async () => {
    const { deps, store } = setup();
    for (let i = 0; i < 100; i++) await store.recordEvent("wright-ai", "call", CALLER, TUESDAY_10AM);
    const out = await handleVapi(deps, { message: { type: "assistant-request", call } });
    expect(out).toEqual({ destination: { type: "number", number: OWNER } });
  });
});

describe("booking tool", () => {
  const book = (args: Record<string, string>) => ({
    message: { type: "tool-calls", call, toolCallList: [{ id: "t1", function: { name: "book_discovery_call", arguments: args } }] },
  });
  const goodArgs = { start: "2026-11-11T21:00:00.000Z", name: "Dana Ruiz", email: "dana@example.com", need: "Missed calls" };

  it("books, confirms to the caller and alerts the owner the same minute", async () => {
    const { deps, sent, store } = setup({
      routes: [(u, init) => (u.endsWith("/v2/bookings") && init?.method === "POST" ? Response.json({ data: { uid: "b1", start: goodArgs.start } }) : undefined)],
    });
    const out = (await handleVapi(deps, book(goodArgs))) as { results: { result: string }[] };
    expect(JSON.parse(out.results[0]!.result).booked).toBe(true);
    // Caller texted; owner emailed, not texted (texts are only for what needs action now).
    expect(sent.map((s) => s.to)).toEqual([CALLER, "owner@example.com"]);
    expect((await store.getCall("call-1"))?.outcome).toBe("booked");
  });

  it("never books twice for the same call, even if the tool is called again", async () => {
    let posts = 0;
    const { deps } = setup({
      routes: [(u, init) => (u.endsWith("/v2/bookings") && init?.method === "POST" ? (posts++, Response.json({ data: { uid: "b1", start: goodArgs.start } })) : undefined)],
    });
    await handleVapi(deps, book(goodArgs));
    const again = (await handleVapi(deps, book({ ...goodArgs, start: "2026-11-11T22:00:00.000Z" }))) as { results: { result: string }[] };
    expect(posts).toBe(1);
    expect(JSON.parse(again.results[0]!.result).say).toMatch(/already has a booking/);
  });

  it("does not retry an unclear booking from the call", async () => {
    let posts = 0;
    const { deps } = setup({ routes: [(u) => (u.endsWith("/v2/bookings") ? (posts++, new Response("oops", { status: 502 })) : undefined)] });
    await handleVapi(deps, book(goodArgs));
    await handleVapi(deps, book(goodArgs));
    expect(posts).toBe(1);
  });

  it("re-offers when the slot was just taken", async () => {
    const { deps } = setup({
      routes: [(u) => (u.endsWith("/v2/bookings") ? Response.json({ error: { message: "User has no available time slot" } }, { status: 409 }) : undefined)],
    });
    const out = (await handleVapi(deps, book(goodArgs))) as { results: { result: string }[] };
    expect(JSON.parse(out.results[0]!.result).say).toMatch(/just taken/);
  });

  it("never says booked when Cal.com's answer is unclear, and alerts the owner", async () => {
    const { deps, sent } = setup({ routes: [(u) => (u.endsWith("/v2/bookings") ? new Response("oops", { status: 502 }) : undefined)] });
    const out = (await handleVapi(deps, book(goodArgs))) as { results: { result: string }[] };
    const result = JSON.parse(out.results[0]!.result);
    expect(result.booked).toBe(false);
    expect(result.say).toMatch(/Do not say it is booked/);
    expect(sent.some((s) => s.to === OWNER && s.body.startsWith("CHECK CAL.COM"))).toBe(true);
  });

  it("asks again for an incomplete email instead of booking", async () => {
    const { deps, sent } = setup();
    const out = (await handleVapi(deps, book({ ...goodArgs, email: "dana at gmail" }))) as { results: { result: string }[] };
    expect(JSON.parse(out.results[0]!.result).booked).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("messages", () => {
  const message = (args: Record<string, unknown>) => ({
    message: { type: "tool-calls", call, toolCallList: [{ id: "t1", function: { name: "take_message", arguments: args } }] },
  });
  it("texts the owner only for urgent messages; routine ones go to email", async () => {
    const routine = setup();
    await handleVapi(routine.deps, message({ name: "Dana", message: "call me about a website" }));
    expect(routine.sent.map((s) => s.channel)).toEqual(["email"]);
    const urgent = setup();
    await handleVapi(urgent.deps, message({ name: "Dana", message: "your bot texted my customers at 3am", urgent: true }));
    expect(urgent.sent.map((s) => [s.channel, s.to])).toEqual([["sms", OWNER], ["email", "owner@example.com"]]);
  });
});

describe("text-back", () => {
  it("texts a missed caller once a day and alerts the owner", async () => {
    const { deps, sent, store } = setup();
    const business = deps.businesses[0]!;
    const first = await missedCallTextBack({ store, notify: deps.notify, now: TUESDAY_10AM }, business, CALLER, "no-answer");
    const second = await missedCallTextBack({ store, notify: deps.notify, now: TUESDAY_10AM }, business, CALLER, "no-answer");
    expect(first).toEqual({ sent: true });
    expect(second).toEqual({ sent: false, why: "already texted in the last 24 hours" });
    expect(sent.filter((s) => s.to === CALLER)).toHaveLength(1);
    expect(sent.filter((s) => s.to === OWNER)).toHaveLength(2);
  });

  it("respects quiet hours and opt-outs", async () => {
    const { deps, store } = setup();
    const business = deps.businesses[0]!;
    expect(await missedCallTextBack({ store, notify: deps.notify, now: TUESDAY_11PM }, business, CALLER, "x")).toEqual({ sent: false, why: "outside 8am-9pm for the recipient; queued to send when texting is allowed" });
    await store.setOptOut(CALLER, true);
    expect(await missedCallTextBack({ store, notify: deps.notify, now: TUESDAY_10AM }, business, CALLER, "x")).toEqual({ sent: false, why: "caller opted out" });
  });

  it("fires only for calls that failed before the caller got anywhere", () => {
    expect(needsTextBack("pipeline-error-anthropic-llm-failed", 3, "unknown")).toBe(true);
    expect(needsTextBack("customer-ended-call", 0, "unknown")).toBe(true);
    expect(needsTextBack("customer-ended-call", 4, "unknown")).toBe(false);
    expect(needsTextBack("assistant-ended-call", 1, "unknown")).toBe(false);
    expect(needsTextBack("silence-timed-out", 0, "booked")).toBe(false);
    expect(needsTextBack("assistant-forwarded-call", 2, "unknown")).toBe(false);
  });
});

describe("twilio voice switch", () => {
  const post = (app: ReturnType<typeof createApp>, path: string, form: Record<string, string>) =>
    app.request(path, { method: "POST", body: new URLSearchParams(form), headers: { "Content-Type": "application/x-www-form-urlencoded" } });

  it("hands calls to Vapi while the agent runs", async () => {
    const { deps } = setup();
    const res = await post(createApp(deps), "/twilio/voice", { To: NUMBER, From: CALLER });
    expect(await res.text()).toContain("<Redirect method=\"POST\">https://api.vapi.ai/twilio/inbound_call</Redirect>");
  });

  it("dials the owner when the kill switch is on, and texts back if they don't answer", async () => {
    const { deps, sent } = setup({ env: { KILL_SWITCH: "on" } });
    const app = createApp(deps);
    const res = await post(app, "/twilio/voice", { To: NUMBER, From: CALLER });
    expect(await res.text()).toContain(`<Dial timeout="20" action="https://receptionist.example.com/twilio/dial-result" method="POST">${OWNER}</Dial>`);
    await post(app, "/twilio/dial-result", { To: NUMBER, From: CALLER, DialCallStatus: "no-answer" });
    expect(sent.some((s) => s.to === CALLER)).toBe(true);
  });

  it("fails closed when the remote pause flag can't be read", async () => {
    const { deps } = setup({ env: { KILL_SWITCH_URL: "https://flag.example.com/flag.json" } });
    deps.fetch = fakeFetch([() => { throw new Error("down"); }]);
    const res = await post(createApp(deps), "/twilio/voice", { To: NUMBER, From: CALLER });
    expect(await res.text()).toContain("<Dial");
  });

  it("fails closed when the pause check is slower than its 1.5-second budget", async () => {
    const { deps } = setup({ env: { KILL_SWITCH_URL: "https://flag.example.com/flag.json" } });
    deps.fetch = (() => new Promise(() => {})) as typeof fetch; // never answers
    const started = Date.now();
    const res = await post(createApp(deps), "/twilio/voice", { To: NUMBER, From: CALLER });
    expect(await res.text()).toContain("<Dial");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("PAUSE, STATUS and RESUME by text from the owner's cell, each confirmed", async () => {
    const { deps } = setup();
    const app = createApp(deps);
    const pause = await (await post(app, "/twilio/sms", { To: NUMBER, From: OWNER, Body: "pause" })).text();
    expect(pause).toContain("<Message>Paused, callers now ring your cell. Reply RESUME to undo.</Message>");
    expect(await (await post(app, "/twilio/voice", { To: NUMBER, From: CALLER })).text()).toContain("<Dial");
    expect(await (await post(app, "/twilio/sms", { To: NUMBER, From: OWNER, Body: "STATUS" })).text()).toContain("paused by owner text");
    const resume = await (await post(app, "/twilio/sms", { To: NUMBER, From: OWNER, Body: "RESUME" })).text();
    expect(resume).toContain("Resumed");
    expect(await (await post(app, "/twilio/voice", { To: NUMBER, From: CALLER })).text()).toContain("<Redirect");
  });

  it("ignores PAUSE from anyone but the owner", async () => {
    const { deps, sent } = setup();
    const app = createApp(deps);
    await post(app, "/twilio/sms", { To: NUMBER, From: CALLER, Body: "PAUSE" });
    expect(await (await post(app, "/twilio/voice", { To: NUMBER, From: CALLER })).text()).toContain("<Redirect");
    expect(sent.some((s) => s.to === OWNER && s.body.includes("PAUSE"))).toBe(true); // forwarded as a normal text
  });

  it("keeps calls with the owner while the watchdog is tripped, and an owner RESUME doesn't clear it", async () => {
    const { deps } = setup();
    deps.watchdog = new Watchdog();
    for (let i = 0; i < 3; i++) deps.watchdog.record(false, "vapi down");
    const app = createApp(deps);
    const resume = await (await post(app, "/twilio/sms", { To: NUMBER, From: OWNER, Body: "RESUME" })).text();
    expect(resume).toContain("still ring you: watchdog tripped");
    expect(await (await post(app, "/twilio/voice", { To: NUMBER, From: CALLER })).text()).toContain("<Dial");
  });

  it("rejects unsigned Twilio requests when an auth token is set", async () => {
    const { deps } = setup({ env: { TWILIO_AUTH_TOKEN: "secret" } });
    const res = await post(createApp(deps), "/twilio/voice", { To: NUMBER, From: CALLER });
    expect(res.status).toBe(403);
  });

  it("serves the privacy notice and terms", async () => {
    const { deps } = setup();
    const res = await createApp(deps).request("/privacy");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Privacy Notice");
    expect((await createApp(deps).request("/terms")).status).toBe(200);
  });

  it.each(["REVOKE", "optout", "Stop texting me", "please don't text me again"])("treats %j as an opt-out", async (body) => {
    const { deps, store } = setup();
    await post(createApp(deps), "/twilio/sms", { To: NUMBER, From: CALLER, Body: body });
    expect(await store.isOptedOut(CALLER)).toBe(true);
  });

  it("sends no text-back to an opted-out number on its next missed call", async () => {
    const { deps, store } = setup();
    const business = deps.businesses[0]!;
    await store.setOptOut(CALLER, true);
    expect(await missedCallTextBack({ store, notify: deps.notify, now: TUESDAY_10AM }, business, CALLER, "no-answer")).toEqual({ sent: false, why: "caller opted out" });
  });

  it("text-back is automated, links the privacy notice, and the FAQ drops the unverified result", () => {
    const { deps } = setup();
    const b = deps.businesses[0]!;
    expect(b.textBack).toMatch(/automated.*STOP.*\/privacy/);
    expect(JSON.stringify(b.faq)).not.toMatch(/288|86,000/);
  });

  it("prompt routes emergencies to 911 and declines advice and promises", async () => {
    const { deps } = setup();
    const out = (await handleVapi(deps, { message: { type: "assistant-request", call } })) as { assistant: any };
    const prompt: string = out.assistant.model.messages[0].content;
    expect(prompt).toMatch(/hang up and call 911/);
    expect(prompt).toMatch(/no medical, legal, tax or financial advice/);
    expect(prompt).toMatch(/Never promise discounts, refunds, guarantees/);
  });

  it("stores the disclosure version on the call record", async () => {
    const { deps, store } = setup();
    await handleVapi(deps, { message: { type: "assistant-request", call } });
    expect((await store.getCall(call.id))?.disclosureVersion).toBeTruthy();
  });

  it("records STOP as an opt-out", async () => {
    const { deps, store } = setup();
    await post(createApp(deps), "/twilio/sms", { To: NUMBER, From: CALLER, Body: "STOP" });
    expect(await store.isOptedOut(CALLER)).toBe(true);
  });
});

describe("watchdog", () => {
  it("trips after 3 failures in a row and restores after 3 successes, alerting on both", async () => {
    const w = new Watchdog();
    const texts: string[] = [];
    const sms = async (_to: string, _from: string, body: string) => { texts.push(body); };
    let up = false;
    const f = (async () => (up ? new Response("ok") : new Response("down", { status: 503 }))) as typeof fetch;
    const owners = [{ phone: OWNER, from: NUMBER }];
    const ticks = [];
    for (let i = 0; i < 3; i++) ticks.push(await watchdogTick(w, ["https://vapi.test/health"], owners, sms, f));
    expect(ticks).toEqual([null, null, "tripped"]);
    up = true;
    expect(await watchdogTick(w, ["https://vapi.test/health"], owners, sms, f)).toBe(null);
    expect(w.healthy).toBe(false);
    await watchdogTick(w, ["https://vapi.test/health"], owners, sms, f);
    expect(await watchdogTick(w, ["https://vapi.test/health"], owners, sms, f)).toBe("restored");
    expect(texts).toHaveLength(2);
  });

  it("a single blip doesn't flip the line", () => {
    const w = new Watchdog();
    w.record(false); w.record(false); w.record(true); w.record(false); w.record(false);
    expect(w.healthy).toBe(true);
  });
});

describe("vapi auth", () => {
  it("rejects server messages without the shared secret", async () => {
    const { deps } = setup({ env: { VAPI_SECRET: "s3cret" } });
    const res = await createApp(deps).request("/vapi", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(401);
  });
});

describe("legal fixes", () => {
  it("/vapi refuses when live and VAPI_SECRET is unset", async () => {
    const { deps } = setup({ env: { DRY_RUN: "false" } });
    const res = await createApp(deps).request("/vapi", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(503);
  });

  it("an opted-out caller gets no booking text", async () => {
    const { sendCallerSms } = await import("../src/textBack.js");
    const { deps, sent } = setup();
    await deps.store.setOptOut(CALLER, true);
    const r = await sendCallerSms(deps, CALLER, NUMBER, "hi");
    expect(r.sent).toBe(false);
    expect(sent.filter((s) => s.to === CALLER)).toHaveLength(0);
  });

  it("opt-outs survive a restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const file = `${mkdtempSync(`${tmpdir()}/oo-`)}/state.json`;
    await memoryStore(file).setOptOut(CALLER, true);
    expect(await memoryStore(file).isOptedOut(CALLER)).toBe(true);
  });

  it("an unwritable STATE_FILE is logged, not fatal, and shows in the store", async () => {
    const st = memoryStore("/nonexistent-dir/definitely/state.json");
    await st.recordEvent("wright-ai", "text", CALLER, TUESDAY_10AM);
    await st.setFlag("a", "b");
    expect(await st.getFlag("a")).toBe("b");
    expect(st.lastPersistError).toContain("ENOENT");
    const { assertWritable } = await import("../src/store.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const blocker = `${mkdtempSync(`${tmpdir()}/aw-`)}/afile`;
    writeFileSync(blocker, "x");
    expect(() => assertWritable(`${blocker}/sub/state.json`)).toThrow();
  });

  it("a corrupt deferred entry is dropped without blocking the others", async () => {
    const { deps, store } = setup();
    await store.setFlag("deferred-textback:wright-ai|+14805550100", "{not json");
    await expect(flushDeferredTextBacks({ store, notify: deps.notify, now: () => TUESDAY_10AM }, deps.businesses)).resolves.toBe(0);
    expect(await store.listFlags("deferred-textback:")).toEqual([]);
  });

  it("sweep removes old calls and counts outcomes", async () => {
    const st = memoryStore();
    await st.saveCall({ callId: "old", businessId: "b", caller: CALLER, startedAt: "2026-01-01T00:00:00Z", outcome: "booked" });
    await st.saveCall({ callId: "new", businessId: "b", caller: CALLER, startedAt: "2026-11-09T00:00:00Z", outcome: "message" });
    expect((await st.outcomesSince("b", new Date("2026-11-01")))["message"]).toBe(1);
    expect(await st.sweep(new Date("2026-06-01"))).toBe(1);
    expect(await st.getCall("old")).toBeUndefined();
  });

  it("quiet hours hold in Eastern and Pacific time too", async () => {
    const { textingAllowed } = await import("../src/safety/hours.js");
    expect(textingAllowed(new Date("2026-11-10T20:00:00Z"), "America/Phoenix")).toBe(true); // 1pm PT/AZ, 3pm ET
    expect(textingAllowed(new Date("2026-11-10T15:30:00Z"), "America/Phoenix")).toBe(false); // 7:30am PT
    expect(textingAllowed(new Date("2026-11-11T02:30:00Z"), "America/Phoenix")).toBe(false); // 9:30pm ET
    expect(textingAllowed(new Date("2026-11-10T20:00:00Z"), "America/Phoenix", "+18085551234")).toBe(false);
  });

  it("stub prompts carry the emergency and no-advice rules", async () => {
    const { buildStubAssistant } = await import("../src/vapi/assistant.js");
    const { deps } = setup();
    for (const canTransfer of [true, false]) {
      const a = buildStubAssistant(deps.env, deps.businesses[0]!, { canTransfer, now: new Date() }) as any;
      const p = a.model.messages[0].content as string;
      expect(p).toContain("911");
      expect(p).toContain("no medical, legal, tax or financial advice");
    }
  });
});

describe("admin delete", () => {
  it("needs the admin secret, then deletes by number", async () => {
    const { deps, store } = setup({ env: { ADMIN_SECRET: "adm" } });
    await store.saveCall({ callId: "c9", businessId: "wright-ai", caller: CALLER, startedAt: "x", outcome: "message" });
    const app = createApp(deps);
    const post = (h: Record<string, string>) => app.request("/admin/delete", { method: "POST", body: JSON.stringify({ phone: CALLER }), headers: { "Content-Type": "application/json", ...h } });
    expect((await post({})).status).toBe(401);
    expect((await post({ Authorization: "Bearer adm" })).status).toBe(200);
    expect(await store.getCall("c9")).toBeUndefined();
  });
});

describe("fix round 1", () => {
  const post = (app: ReturnType<typeof createApp>, path: string, form: Record<string, string>) =>
    app.request(path, { method: "POST", body: new URLSearchParams(form), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  const msg = (args: Record<string, unknown>) => ({
    message: { type: "tool-calls", call, toolCallList: [{ id: "t1", function: { name: "take_message", arguments: args } }] },
  });
  const failingEmail = (): { deps: Deps; sent: Sent[] } => {
    const { deps, sent } = setup();
    const ok = deps.notify;
    deps.notify = { ...ok, async email(to, subject, body) { return { channel: "email", to, subject, body, dryRun: false, ok: false, error: "Resend 500" }; } };
    return { deps, sent };
  };

  it("keeps a message when email fails, and falls back to SMS", async () => {
    const { deps, sent } = failingEmail();
    await handleVapi(deps, msg({ name: "Dana", callback: "+14805550123", message: "call me about a website" }));
    expect(sent.filter((s) => s.channel === "sms" && s.to === OWNER && s.body.includes("call me about a website"))).toHaveLength(1);
    const saved = await deps.store.getCall("call-1");
    expect(saved?.message).toMatchObject({ name: "Dana", text: "call me about a website", delivered: "sms" });
  });

  it("keeps a message even when nothing can be sent", async () => {
    const { deps } = failingEmail();
    deps.businesses[0]!.ownerPhone = "";
    await handleVapi(deps, msg({ name: "Dana", message: "hello" }));
    expect((await deps.store.getCall("call-1"))?.message).toMatchObject({ text: "hello", delivered: "none" });
  });

  it("does not treat ordinary replies as opt-outs, and forwards them", async () => {
    for (const body of ["Can you stop by Tuesday? text me the price", "Do not have email, please text me a time", "dont call me, text me instead", "yes"]) {
      const { deps, sent } = setup();
      await post(createApp(deps), "/twilio/sms", { To: NUMBER, From: CALLER, Body: body });
      expect(await deps.store.isOptedOut(CALLER)).toBe(false);
      expect(sent.some((s) => s.to === OWNER && s.body.includes(body))).toBe(true);
    }
  });

  it("opts out on clear requests, confirms, and still tells the owner", async () => {
    const { deps, sent } = setup();
    const res = await (await post(createApp(deps), "/twilio/sms", { To: NUMBER, From: CALLER, Body: "please stop texting me" })).text();
    expect(await deps.store.isOptedOut(CALLER)).toBe(true);
    expect(res).toContain("opted out");
    expect(sent.some((s) => s.to === OWNER && s.body.includes("Possible opt-out"))).toBe(true);
  });

  it("owner PAUSE and booking keys survive a restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const file = `${mkdtempSync(`${tmpdir()}/st-`)}/state.json`;
    const a = memoryStore(file);
    await a.setFlag("paused:wright-ai", "now");
    await a.saveCall({ callId: "c9", businessId: "wright-ai", caller: CALLER, startedAt: "2026-11-10T17:00:00Z", outcome: "message" });
    await a.recordEvent("wright-ai", "text", CALLER, TUESDAY_10AM);
    const b = memoryStore(file);
    expect(await b.getFlag("paused:wright-ai")).toBe("now");
    expect((await b.getCall("c9"))?.outcome).toBe("message");
    expect(await b.lastTextTo("wright-ai", CALLER)).toEqual(TUESDAY_10AM);
  });

  it("emails the owner a summary at the end of each call", async () => {
    const { deps, sent } = setup();
    await handleVapi(deps, { message: { type: "end-of-call-report", call, endedReason: "assistant-ended-call", analysis: { summary: "Asked about pricing." }, artifact: { recordingUrl: "https://rec.example/1", messages: [{ role: "user" }, { role: "user" }] } } });
    const mail = sent.find((s) => s.channel === "email");
    expect(mail?.body).toContain("Asked about pricing.");
    expect(mail?.body).toContain("https://rec.example/1");
  });

  it("queues an after-hours text-back and sends it when the window opens", async () => {
    const { deps, sent, store } = setup();
    const business = deps.businesses[0]!;
    await missedCallTextBack({ store, notify: deps.notify, now: TUESDAY_11PM }, business, CALLER, "no-answer");
    expect(sent.filter((s) => s.to === CALLER)).toHaveLength(0);
    expect(await flushDeferredTextBacks({ store, notify: deps.notify, now: () => TUESDAY_11PM }, deps.businesses)).toBe(0);
    const next = new Date(TUESDAY_11PM.getTime() + 15 * 3600_000); // ~10am Phoenix next day
    expect(await flushDeferredTextBacks({ store, notify: deps.notify, now: () => next }, deps.businesses)).toBe(1);
    expect(sent.filter((s) => s.to === CALLER)).toHaveLength(1);
  });

  it("books without a phone number when caller ID is hidden", async () => {
    let body = "";
    const route: Route = (url, init) => {
      if (!url.includes("/v2/bookings")) return undefined;
      body = String(init?.body);
      return Response.json({ data: { uid: "u1", status: "accepted" } });
    };
    const { deps } = setup({ routes: [route], env: { CAL_API_KEY: "k" } });
    const hidden = { id: "call-h", phoneNumber: { number: NUMBER } };
    await handleVapi(deps, { message: { type: "tool-calls", call: hidden, toolCallList: [{ id: "t", function: { name: "book_discovery_call", arguments: { start: "2026-11-11T21:00:00.000Z", name: "Dana", email: "d@x.com", need: "site" } } }] } });
    expect(body).not.toContain("unknown");
  });

  it("status endpoint needs the admin secret and reports real state", async () => {
    const { deps } = setup({ env: { ADMIN_SECRET: "s3cret", APP_VERSION: "abc123" } });
    deps.fetch = fakeFetch([() => new Response("x", { status: 401 })]);
    const app = createApp(deps);
    expect((await app.request("/admin/status.json")).status).toBe(401);
    const res = await app.request("/admin/status.json", { headers: { Authorization: "Bearer s3cret" } });
    const j = (await res.json()) as any;
    expect(j.basic.find((f: any) => f.name === "Version").detail).toBe("abc123");
    expect(j.status).toBeDefined();
    expect(j.important[0].last_checked).toBeDefined();
    expect(j.key.find((f: any) => f.name === "Watchdog").status).toBe("unknown");
    expect(j.latestUpdate).toContain("Latest Update");
  });

  it("/health fails when live config is missing", async () => {
    const { deps } = setup({ env: { DRY_RUN: "false" } });
    expect((await createApp(deps).request("/health")).status).toBe(503);
  });
});
