// Watches the voice platform and decides whether calls should go to the
// agent. Hysteresis keeps a short blip from flipping the line: it trips only
// after TRIP consecutive failed checks and restores only after RESTORE
// consecutive good ones, and both transitions are reported so the owner is
// told when the line moves to their phone and when it moves back.
//
// This is separate from the owner's manual pause (PAUSE by text) and the
// KILL_SWITCH setting: those are never cleared by the watchdog, and the
// watchdog is never cleared by them.

export const TRIP = 3;
export const RESTORE = 3;

export type Transition = "tripped" | "restored" | null;

export class Watchdog {
  healthy = true;
  private fails = 0;
  private oks = 0;
  lastError: string | undefined;

  record(ok: boolean, error?: string): Transition {
    if (ok) {
      this.oks += 1;
      this.fails = 0;
      if (!this.healthy && this.oks >= RESTORE) {
        this.healthy = true;
        this.lastError = undefined;
        return "restored";
      }
      return null;
    }
    this.fails += 1;
    this.oks = 0;
    this.lastError = error;
    if (this.healthy && this.fails >= TRIP) {
      this.healthy = false;
      return "tripped";
    }
    return null;
  }
}

/** One check: the URL answers 2xx within 5 seconds. */
export async function probe(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One watchdog tick: every URL must answer. On a transition, every business
 * owner is texted, so the owner always knows when calls move to their phone
 * and when they move back.
 */
export async function watchdogTick(
  watchdog: Watchdog,
  urls: string[],
  owners: { phone: string; from: string }[],
  sms: (to: string, from: string, body: string) => Promise<unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<Transition> {
  const results = await Promise.all(urls.map((u) => probe(u, fetchImpl)));
  const failed = results.find((r) => !r.ok);
  const transition = watchdog.record(!failed, failed?.error);
  if (transition) {
    const body =
      transition === "tripped"
        ? `Watchdog: the AI receptionist failed ${TRIP} checks in a row (${failed?.error ?? "unknown"}). New calls now ring your cell. It switches back by itself after ${RESTORE} good checks.`
        : `Watchdog: checks are passing again. New calls go back to the AI receptionist.`;
    for (const o of owners) if (o.phone && o.from) await sms(o.phone, o.from, body);
  }
  return transition;
}
