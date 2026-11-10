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
      const auth = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!deps.env.ADMIN_SECRET || !sameSecret(auth, deps.env.ADMIN_SECRET)) return c.json({ error: "unauthorized" }, 401);
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
