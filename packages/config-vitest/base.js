/**
 * @sparklab/config-vitest — base preset.
 *
 * Pure-logic suites (schemas, utils, non-React classes). Runs in Node
 * environment with coverage via v8.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
