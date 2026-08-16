import type { NextConfig } from "next";

const gatewayOrigin =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3007";

const nextConfig: NextConfig = {
  // E2E builds set NEXT_DIST_DIR (e.g. ".next-e2e") so the production build
  // Playwright serves can't be clobbered by a concurrently running `next dev`,
  // which rewrites `.next` and corrupts the prod routes manifest.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  transpilePackages: ["@sparklab/ui", "@sparklab/shared-types"],

  experimental: {
    // The /api/:path* rewrite below proxies through Next's middleware layer,
    // which caps request bodies at 10MB by default — well under the
    // gateway's FS_UPLOAD_CAP (1GB). Without this, file-explorer uploads
    // over 10MB reset the connection before reaching the gateway.
    middlewareClientMaxBodySize: "1gb",
  },

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
