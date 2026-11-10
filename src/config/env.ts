import { z } from "zod";

// Every setting the service reads, checked once at start-up. Secrets are
// optional so tests and local runs work without accounts; each feature checks
// for what it needs and stays off (or fails closed) without it.
const schema = z.object({
  PORT: z.coerce.number().default(8080),
  /** Public base URL of this service, used for Twilio callbacks and Vapi tool URLs. */
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  /** Shared secret Vapi sends as X-Vapi-Secret on every server message. */
  VAPI_SECRET: z.string().optional(),
  /** Model for the live call. Fast and small; must be on Vapi's supported list. */
  VAPI_MODEL_PROVIDER: z.string().default("anthropic"),
  VAPI_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  /** Where calls go when the agent is running: Vapi's Twilio inbound webhook. Verify in week-1 tests. */
  VAPI_TWILIO_INBOUND_URL: z.string().url().default("https://api.vapi.ai/twilio/inbound_call"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  CAL_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("AI Receptionist <receptionist@wright-ai-solutions.com>"),
  /** "on" sends every call straight to the owner's phone. */
  KILL_SWITCH: z.enum(["on", "off"]).default("off"),
  /** Optional remote flag: JSON {"paused": true} pauses the agent. Fails closed when set and unreachable. */
  KILL_SWITCH_URL: z.string().url().optional(),
  /** "true" logs texts and emails instead of sending them. */
  DRY_RUN: z.enum(["true", "false"]).default("true"),
  OWNER_PHONE_WRIGHT_AI: z.string().optional(),
  OWNER_EMAIL_WRIGHT_AI: z.string().optional(),
  WRIGHT_AI_NUMBER: z.string().optional(),
  CAL_LINK_WRIGHT_AI: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source);
}
