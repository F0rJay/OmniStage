import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@modelcontextprotocol/sdk",
    "@langchain/langgraph",
    "@langchain/core",
    "mem0ai",
  ],
};

export default nextConfig;
