import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "@sparklab/config-vitest/base";

export default mergeConfig(baseConfig, defineConfig({}));
