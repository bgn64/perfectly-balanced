import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.CONTAINER_TEST_URL) {
  process.env.TEST_DATABASE_PATH ??= join(mkdtempSync(join(tmpdir(), "balanced-browser-")), "hosting.sqlite");
  process.env.BETTER_AUTH_SECRET = "fictional-browser-tests-only-secret-32-characters";
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:5175";
  process.env.APP_ENV = "local";
}

export default defineConfig({
  globalTeardown: "./scripts/container/browser-cleanup.ts",
  testDir: "./tests/hosting",
  outputDir: "./test-results/hosting",
  use: { baseURL: "http://127.0.0.1:5175", trace: "retain-on-failure" },
  webServer: process.env.CONTAINER_TEST_URL ? undefined : {
    command: "node scripts/container/hosting-test-server.ts",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium", baseURL: process.env.CONTAINER_TEST_URL ?? "http://127.0.0.1:5175" } }],
});
