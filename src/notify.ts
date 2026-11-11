import type { Env } from "./config/env.js";
import type { Store } from "./store.js";
import { VOLATILE } from "./store.js";

// Texts and emails. With DRY_RUN=true (the default) nothing is sent; each
// message is logged and returned so tests and the first live runs can see it.

/** Per-dependency timeout for Twilio and Resend. No retries: a retried send could text twice. */
const TIMEOUT_MS = 5000;

export interface Sent {
  channel: "sms" | "email";
  to: string;
  body: string;
  from?: string;
  subject?: string;
  dryRun: boolean;
  ok: boolean;
  error?: string;
}

export interface Notifier {
  sms(to: string, from: string, body: string): Promise<Sent>;
  email(to: string, subject: string, body: string): Promise<Sent>;
}

export function notifier(env: Env, fetchImpl: typeof fetch = fetch): Notifier {
  const dryRun = env.DRY_RUN !== "false";
  return {
    async sms(to, from, body) {
      const base: Sent = { channel: "sms", to, from, body, dryRun, ok: true };
      if (dryRun) {
        console.log(JSON.stringify({ event: "sms.dry-run", to, from, body }));
        return base;
      }
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return { ...base, ok: false, error: "Twilio not configured" };
      try {
        const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
        const response = await fetchImpl(
          `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: "POST",
            headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ To: to, From: from, Body: body }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        return response.ok ? base : { ...base, ok: false, error: `Twilio ${response.status}` };
      } catch (err) {
        return { ...base, ok: false, error: String(err) };
      }
    },
    async email(to, subject, body) {
      const base: Sent = { channel: "email", to, subject, body, dryRun, ok: true };
      if (dryRun) {
        console.log(JSON.stringify({ event: "email.dry-run", to, subject, body }));
        return base;
      }
      if (!env.RESEND_API_KEY || !to) return { ...base, ok: false, error: "email not configured" };
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text: body }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return response.ok ? base : { ...base, ok: false, error: `Resend ${response.status}` };
      } catch (err) {
        return { ...base, ok: false, error: String(err) };
      }
    },
  };
}

/** Key holding the last real send result for a channel: "<iso> ok" or "<iso> <error>". Memory only. */
export const sendKey = (channel: "sms" | "email") => `${VOLATILE}send:${channel}`;

/** Wraps a notifier so the status endpoint can show whether Twilio and Resend last worked. Dry runs are not recorded. */
export function recordingNotifier(inner: Notifier, store: Store, now: () => Date = () => new Date()): Notifier {
  const note = (s: Sent): Sent => {
    if (!s.dryRun) void store.setFlag(sendKey(s.channel), `${now().toISOString()} ${s.ok ? "ok" : s.error ?? "failed"}`).catch(() => undefined);
    return s;
  };
  return {
    async sms(to, from, body) { return note(await inner.sms(to, from, body)); },
    async email(to, subject, body) { return note(await inner.email(to, subject, body)); },
  };
}
