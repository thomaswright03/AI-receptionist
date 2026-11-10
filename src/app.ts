import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { validTwilioSignature } from "./twilio/signature.js";
import * as twilio from "./twilio/routes.js";
import { handleVapi, type Deps } from "./vapi/handler.js";

function sameSecret(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, dryRun: deps.env.DRY_RUN !== "false", businesses: deps.businesses.map((b) => b.id) }));

  // Public legal documents (linked from the text-back and the 10DLC registration).
  for (const [path, file] of [["/privacy", "privacy.md"], ["/terms", "terms.md"]] as const) {
    app.get(path, async (c) => {
      const text = await readFile(new URL(`../docs/legal/${file}`, import.meta.url), "utf8").catch(() => null);
      return text ? c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" }) : c.text("not found", 404);
    });
  }

  // Vapi server messages. When VAPI_SECRET is set, every request must carry it.
  app.post("/vapi", async (c) => {
    if (deps.env.VAPI_SECRET && !sameSecret(deps.env.VAPI_SECRET, c.req.header("x-vapi-secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    return c.json(await handleVapi(deps, body));
  });

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
