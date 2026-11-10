import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadBusinesses } from "./config/businesses.js";
import { loadEnv } from "./config/env.js";
import { notifier } from "./notify.js";
import { memoryStore } from "./store.js";
import { Watchdog, watchdogTick } from "./safety/watchdog.js";

// Always-warm process (Fly.io), so live-call tool requests never wait on a cold start.
const env = loadEnv();
const businesses = loadBusinesses(env);
const notify = notifier(env);
const watchdog = new Watchdog();
const app = createApp({ env, businesses, store: memoryStore(), notify, watchdog });

const watchUrls = env.WATCHDOG_URLS.split(",").map((u) => u.trim()).filter(Boolean);
if (watchUrls.length) {
  const owners = businesses.map((b) => ({ phone: b.ownerPhone, from: b.inboundNumbers[0] ?? "" }));
  setInterval(() => {
    watchdogTick(watchdog, watchUrls, owners, notify.sms).catch((err) => console.error(JSON.stringify({ event: "watchdog.error", err: String(err) })));
  }, 60_000);
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(JSON.stringify({ event: "listening", port: info.port, dryRun: env.DRY_RUN !== "false" }));
});
