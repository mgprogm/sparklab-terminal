import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@sparklab/ui", "@sparklab/shared-types"],
};

export default nextConfig;
