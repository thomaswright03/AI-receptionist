import type { Env } from "../config/env.js";
import type { Business } from "../config/types.js";
import type { Store } from "../store.js";
import { plainStatus } from "../status.js";
import type { Watchdog } from "./watchdog.js";

// Where does a NEW call go: the agent, or the owner's phone?
//
// The kill switch pauses new calls only. Calls already with the agent finish
// normally. While paused, the Twilio number dials the owner (and texts the
// caller back if they don't answer). Four things can pause a business, each
// set and cleared on its own:
//   1. KILL_SWITCH=on in the service settings (every business)
//   2. The owner texts PAUSE to the business number (RESUME undoes it)
//   3. The watchdog has tripped (clears itself after it recovers)
//   4. The optional remote flag says paused, or can't be read (fail closed)

export const pauseKey = (businessId: string) => `paused:${businessId}`;

export async function agentPaused(
  deps: { env: Env; store: Store; watchdog?: Watchdog; fetch?: typeof fetch },
  business: Business,
): Promise<{ paused: boolean; why: string }> {
  if (deps.env.KILL_SWITCH === "on") return { paused: true, why: "KILL_SWITCH=on" };
  const manual = await deps.store.getFlag(pauseKey(business.id));
  if (manual) return { paused: true, why: `paused by owner text at ${manual}` };
  if (deps.watchdog && !deps.watchdog.healthy) return { paused: true, why: `watchdog tripped: ${deps.watchdog.lastError ?? "unknown"}` };
  if (!deps.env.KILL_SWITCH_URL) return { paused: false, why: "running" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await (deps.fetch ?? fetch)(deps.env.KILL_SWITCH_URL, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!response.ok) return { paused: true, why: `flag returned ${response.status}` };
    const body = (await response.json()) as { paused?: unknown };
    return body.paused === false ? { paused: false, why: "running" } : { paused: true, why: "remote flag says paused" };
  } catch {
    return { paused: true, why: "remote flag unreachable" };
  }
}

/**
 * Owner commands by text, from the owner's own cell to the business number:
 * PAUSE (calls ring the owner), RESUME (calls go to the agent), STATUS, HELP.
 * Returns the reply to send, or undefined if the text wasn't a command.
 */
export async function ownerCommand(
  deps: { env: Env; store: Store; watchdog?: Watchdog; fetch?: typeof fetch; now?: () => Date },
  business: Business,
  body: string,
): Promise<string | undefined> {
  const word = body.trim().toUpperCase();
  if (word === "PAUSE") {
    await deps.store.setFlag(pauseKey(business.id), (deps.now?.() ?? new Date()).toISOString());
    return "Paused, callers now ring your cell. Reply RESUME to undo.";
  }
  if (word === "RESUME") {
    await deps.store.setFlag(pauseKey(business.id), undefined);
    const state = await agentPaused(deps, business);
    return state.paused
      ? `Your pause is cleared, but calls still ring you: ${state.why}.`
      : "Resumed, callers now reach the AI receptionist. Reply PAUSE to undo.";
  }
  if (word === "HELP" || word === "?") {
    return "Texts you can send this number: PAUSE (calls ring your cell), RESUME (calls go to the AI receptionist), STATUS (what happened lately and anything broken). Replies you get here are alerts about missed calls and messages.";
  }
  if (word === "STATUS") {
    return plainStatus(deps, business, await agentPaused(deps, business), deps.now?.() ?? new Date());
  }
  return undefined;
}
