import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/**/*.test.ts", "apps/web/src/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/cutover/**/*.test.ts"], testTimeout: 15000, hookTimeout: 30000 },
});
