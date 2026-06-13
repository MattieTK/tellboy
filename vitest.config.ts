import { defineConfig } from "vitest/config";

// Plain Node test run. We test the pure/logic modules (formatting, plugin
// enablement) that don't depend on the Workers runtime. Modules that import
// `cloudflare:workers` (agent.ts, index.ts) are covered by `pnpm typecheck`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
