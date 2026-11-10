import type { Env } from "./config/env.js";

// Texts and emails. With DRY_RUN=true (the default) nothing is sent; each
// message is logged and returned so tests and the first live runs can see it.

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
        });
        return response.ok ? base : { ...base, ok: false, error: `Resend ${response.status}` };
      } catch (err) {
        return { ...base, ok: false, error: String(err) };
      }
    },
  };
}
