import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/hosting",
  outputDir: "./test-results/hosting",
  use: { baseURL: "http://127.0.0.1:5175", trace: "retain-on-failure" },
  webServer: {
    command: "npm exec -w @balanced/web -- vite preview --host 127.0.0.1 --port 5175 --strictPort",
    url: "http://127.0.0.1:5175",
    reuseExistingServer: false,
  },
});
