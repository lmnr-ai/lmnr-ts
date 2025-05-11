import { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@lmnr-ai/lmnr", '../../dist']
};

export default nextConfig;
