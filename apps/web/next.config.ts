import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: ["@balanced/domain", "@balanced/data"],
  serverExternalPackages: ["better-sqlite3"],
};
export default config;
