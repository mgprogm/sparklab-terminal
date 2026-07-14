import type { NextConfig } from "next";

const gatewayOrigin =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3007";

const nextConfig: NextConfig = {
  // E2E builds set NEXT_DIST_DIR (e.g. ".next-e2e") so the production build
  // Playwright serves can't be clobbered by a concurrently running `next dev`,
  // which rewrites `.next` and corrupts the prod routes manifest.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  transpilePackages: ["@sparklab/ui", "@sparklab/shared-types"],

  async rewrites() {
    return [
      {
        // Proxy REST API calls to the gateway (same-origin for the browser).
        source: "/api/:path*",
        destination: `${gatewayOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
