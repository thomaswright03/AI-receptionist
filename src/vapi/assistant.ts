import type { Env } from "../config/env.js";
import type { Business, Flow } from "../config/types.js";

// Builds the Vapi assistant for one call, returned on Vapi's
// "assistant-request". Everything the agent needs to quote, answer and offer
// times is put in the prompt at call start, so the only mid-call hops are the
// ones that change something (booking, taking a message).
//
// Vapi field names follow https://docs.vapi.ai/api-reference (assistant
// object). Verify against the live API during the week-1 test calls.

export function spokenTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function systemPrompt(
  business: Business,
  flow: Flow,
  ctx: { now: Date; openTimes: string[] | null; canTransfer: boolean },
): string {
  const tz = business.timeZone;
  const times =
    ctx.openTimes === null
      ? "The calendar could not be loaded. Do not offer times; take a message so the owner can call back to book."
      : ctx.openTimes.length === 0
        ? "There are no open times in the next week. Take a message so the owner can call back to book."
        : ctx.openTimes.map((t) => `- ${spokenTime(t, tz)} (start: ${t})`).join("\n");
  const faq = business.faq.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");
  return [
    `You are ${business.agentName}, the AI receptionist for ${business.name}, ${business.about}.`,
    `Your job: ${flow.purpose}.`,
    `It is now ${spokenTime(ctx.now.toISOString(), tz)} (${tz}).`,
    "",
    "HOW TO TALK",
    "- This is a phone call. Keep every reply to one or two short sentences. Ask one question at a time.",
    "- Be warm and plain. Never use lists, markdown, or read out URLs.",
    "- If asked whether you are an AI, say yes.",
    "",
    "FIRST, SORT THE CALL",
    "- If the caller is selling something (marketing, SEO, leads, software, loans), or is clearly another automated voice agent, say: 'Thanks for calling. We're not taking sales calls by phone, but you're welcome to email us. Have a good day.' Then end the call.",
    "- If it is a wrong number, say so kindly and end the call.",
    "",
    "ANSWERING QUESTIONS",
    "- Answer only from the approved answers below, in your own words. If a question is not covered, say the owner can answer that on a short call, and offer to book one.",
    "- Never invent prices, timelines, clients, results, or features.",
    "",
    "APPROVED ANSWERS",
    faq,
    "",
    "TO BOOK A CALL, LEARN",
    ...flow.questions.map((q) => `- ${q}`),
    "- Always ask the caller's name, even if they called before.",
    "- If they have no email or won't give one, call take_message instead with what they need, and tell them the owner will call them back.",
    "",
    "OPEN TIMES (offer at most three at once; use the exact start value when booking)",
    times,
    "",
    "RULES",
    ...flow.rules.map((r) => `- ${r}`),
    "- If book_discovery_call says the time was just taken, apologise and offer the next open times.",
    "- If book_discovery_call says it is unsure, tell the caller the owner will confirm by text shortly. Do not say it is booked.",
    ctx.canTransfer
      ? "- If the caller asks for a person, is upset, has an urgent problem, or you are stuck, transfer the call to the owner."
      : "- The owner is not available right now. If the caller asks for a person or you are stuck, call take_message and say the owner will call back.",
    "- Say goodbye and end the call once the caller is done.",
  ].join("\n");
}

export function buildAssistant(
  env: Env,
  business: Business,
  flow: Flow,
  ctx: { now: Date; openTimes: string[] | null; canTransfer: boolean },
): Record<string, unknown> {
  const toolServer = {
    url: `${env.PUBLIC_URL}/vapi`,
    ...(env.VAPI_SECRET ? { headers: { "X-Vapi-Secret": env.VAPI_SECRET } } : {}),
  };
  const tools: Record<string, unknown>[] = [];
  if (flow.tools.includes("book_discovery_call") && business.cal && ctx.openTimes?.length) {
    tools.push({
      type: "function",
      function: {
        name: "book_discovery_call",
        description: "Book the discovery call once you have the caller's name, email, what they need, and a start time they agreed to.",
        parameters: {
          type: "object",
          properties: {
            start: { type: "string", description: "The exact start value of the chosen open time." },
            name: { type: "string" },
            email: { type: "string" },
            business_name: { type: "string" },
            need: { type: "string", description: "What they want help with, in their words." },
          },
          required: ["start", "name", "email", "need"],
        },
      },
      server: toolServer,
    });
  }
  if (flow.tools.includes("take_message")) {
    tools.push({
      type: "function",
      function: {
        name: "take_message",
        description: "Pass a message to the owner, who will call the caller back. Use when you can't book or transfer.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            message: { type: "string", description: "What the caller needs, in their words." },
            callback_number: { type: "string", description: "Only if different from the number they called from." },
          },
          required: ["name", "message"],
        },
      },
      server: toolServer,
    });
  }
  if (ctx.canTransfer && business.ownerPhone) {
    tools.push({
      type: "transferCall",
      destinations: [
        { type: "number", number: business.ownerPhone, message: "One moment, I'm connecting you now.", description: "The owner" },
      ],
    });
  }
  tools.push({ type: "endCall" });

  return {
    name: `${business.id}-${flow.id}`,
    firstMessage: `Thanks for calling ${business.name}, this is ${business.agentName}, an AI assistant. Calls are recorded and may be used for quality and demos. How can I help?`,
    model: {
      provider: env.VAPI_MODEL_PROVIDER,
      model: env.VAPI_MODEL,
      temperature: 0.3,
      messages: [{ role: "system", content: systemPrompt(business, flow, ctx) }],
      tools,
    },
    voice: business.voice,
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    server: toolServer,
    serverMessages: ["end-of-call-report", "status-update", "tool-calls"],
    silenceTimeoutSeconds: 20,
    maxDurationSeconds: 900,
    metadata: { businessId: business.id, flowId: flow.id },
  };
}
