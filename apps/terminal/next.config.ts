import type { NextConfig } from "next";

const gatewayOrigin =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3007";

const nextConfig: NextConfig = {
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
