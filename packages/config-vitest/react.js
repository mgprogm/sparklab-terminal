/**
 * @sparklab/config-vitest — react preset.
 *
 * jsdom environment, @testing-library/jest-dom matchers, React plugin for
 * JSX transform. For component and hooks tests.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["@testing-library/jest-dom/vitest"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
});
