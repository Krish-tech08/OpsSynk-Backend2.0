import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/machine-date.ts"],
    testTimeout: 20000,
    env: { LOG_LEVEL: "silent" },
  },
});
