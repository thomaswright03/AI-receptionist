import type { Env } from "../config/env.js";

// Is the agent paused? When it is, the Twilio number dials the owner instead.
// A remote flag that is set but can't be read counts as paused (fail closed):
// a caller reaching a person is always safe, a broken agent is not.
export async function agentPaused(env: Env, fetchImpl: typeof fetch = fetch): Promise<{ paused: boolean; why: string }> {
  if (env.KILL_SWITCH === "on") return { paused: true, why: "KILL_SWITCH=on" };
  if (!env.KILL_SWITCH_URL) return { paused: false, why: "no remote flag" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetchImpl(env.KILL_SWITCH_URL, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!response.ok) return { paused: true, why: `flag returned ${response.status}` };
    const body = (await response.json()) as { paused?: unknown };
    return body.paused === false ? { paused: false, why: "flag says running" } : { paused: true, why: "flag says paused" };
  } catch {
    return { paused: true, why: "flag unreachable" };
  }
}
