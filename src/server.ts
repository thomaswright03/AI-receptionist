import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadBusinesses } from "./config/businesses.js";
import { loadEnv } from "./config/env.js";
import { notifier } from "./notify.js";
import { memoryStore } from "./store.js";

// Always-warm process (Fly.io), so live-call tool requests never wait on a cold start.
const env = loadEnv();
const app = createApp({ env, businesses: loadBusinesses(env), store: memoryStore(), notify: notifier(env) });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(JSON.stringify({ event: "listening", port: info.port, dryRun: env.DRY_RUN !== "false" }));
});
