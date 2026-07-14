import { defineConfig, mergeConfig } from "vitest/config";
import reactConfig from "@sparklab/config-vitest/react";
import path from "node:path";

export default mergeConfig(
  reactConfig,
  defineConfig({
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    test: {
      // Connection tests run in node env (override per-file with
      // @vitest-environment node comment). Default is jsdom for RTL.
      setupFiles: ["./src/test-setup.ts"],
    },
  }),
);
