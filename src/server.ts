import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadBusinesses } from "./config/businesses.js";
import { loadEnv } from "./config/env.js";
import { notifier } from "./notify.js";
import { assertWritable, memoryStore, RETENTION_DAYS } from "./store.js";
import { sendWeeklySummaries } from "./summary.js";
import { flushDeferredTextBacks } from "./textBack.js";
import { Watchdog, watchdogTick } from "./safety/watchdog.js";

// Always-warm process (Fly.io), so live-call tool requests never wait on a cold start.
const env = loadEnv();
const businesses = loadBusinesses(env);
const notify = notifier(env);
const watchdog = new Watchdog();
if (env.DRY_RUN === "false") {
  // Refuse to take real calls when a message would have nowhere to go.
  const missing = businesses.filter((b) => !b.ownerEmail).map((b) => b.id);
  if (missing.length || !env.STATE_FILE) {
    console.error(JSON.stringify({ event: "startup.refused", why: "DRY_RUN=false needs an owner email for every business, and STATE_FILE", missing }));
    process.exit(1);
  }
}
if (env.STATE_FILE) {
  try {
    assertWritable(env.STATE_FILE);
  } catch (err) {
    console.error(JSON.stringify({ event: "startup.refused", why: "STATE_FILE directory is not writable (is the disk mounted?)", err: String(err) }));
    if (env.DRY_RUN === "false") process.exit(1);
  }
}
const store = memoryStore(env.STATE_FILE);
const app = createApp({ env, businesses, store, notify, watchdog });

const watchUrls = env.WATCHDOG_URLS.split(",").map((u) => u.trim()).filter(Boolean);
if (watchUrls.length) {
  const owners = businesses.map((b) => ({ phone: b.ownerPhone, from: b.inboundNumbers[0] ?? "" }));
  setInterval(() => {
    watchdogTick(watchdog, watchUrls, owners, notify.sms).catch((err) => console.error(JSON.stringify({ event: "watchdog.error", err: String(err) })));
  }, 60_000);
}

setInterval(() => {
  sendWeeklySummaries({ store, notify }, businesses).catch((err) => console.error(JSON.stringify({ event: "weekly.error", err: String(err) })));
}, 3_600_000);

setInterval(() => {
  store.sweep(new Date(Date.now() - RETENTION_DAYS * 86_400_000)).catch((err) => console.error(JSON.stringify({ event: "sweep.error", err: String(err) })));
}, 6 * 3_600_000);

setInterval(() => {
  store.setFlag("flush-last-run", new Date().toISOString()).catch(() => undefined);
  flushDeferredTextBacks({ store, notify }, businesses).catch((err) => console.error(JSON.stringify({ event: "textback.flush.error", err: String(err) })));
}, 60_000);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(JSON.stringify({ event: "listening", port: info.port, dryRun: env.DRY_RUN !== "false" }));
});
