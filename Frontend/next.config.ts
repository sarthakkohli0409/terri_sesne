import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for Render static export or Node server
  output: "standalone",
  // Allow the backend URL to be injected at build time
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
  },
};

export default nextConfig;
