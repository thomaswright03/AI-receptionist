import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"], // process wiring: start-up and timers
      reporter: ["text-summary"],
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 65 },
    },
  },
});
