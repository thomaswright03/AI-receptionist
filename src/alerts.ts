import type { Business } from "./config/types.js";
import type { Notifier } from "./notify.js";
import type { Store } from "./store.js";
import { VOLATILE } from "./store.js";

/** Set when neither SMS nor email reached the owner; shown on the status endpoint. */
export const ALERT_FAILED_KEY = `${VOLATILE}owner-alert:failed`;

/**
 * Tells the owner by text, or by email when there is no owner phone or the text fails.
 * `via: "email"` skips the text (used when the owner was already texted about the same call).
 * If both fail it logs and records the failure for the status endpoint. Returns whether anyone was reached.
 */
export async function alertOwner(
  deps: { notify: Notifier; store: Store; now?: () => Date },
  business: Business,
  subject: string,
  text: string,
  via: "sms" | "email" = "sms",
): Promise<boolean> {
  const from = business.inboundNumbers[0];
  if (via === "sms" && from && business.ownerPhone && (await deps.notify.sms(business.ownerPhone, from, text)).ok) return true;
  const r = await deps.notify.email(business.ownerEmail, subject, text);
  if (r.ok) return true;
  console.error(JSON.stringify({ event: "owner-alert.failed", subject, error: r.error }));
  await deps.store.setFlag(ALERT_FAILED_KEY, `${(deps.now?.() ?? new Date()).toISOString()} ${subject}`).catch(() => undefined);
  return false;
}
