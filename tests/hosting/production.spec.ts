import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";

test("production auth is private and deep-link refreshes load the app", async ({ page }) => {
  for (const route of ["/budget", "/transactions", "/reports"]) {
    const response = await page.goto(`${route}?month=2026-09`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create an account", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Forgot password?", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in instead", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("production bank connections use polished copy without development or migration guidance", async ({ page }, testInfo) => {
  const config = z.object({ API_URL: z.string(), SERVICE_ROLE_KEY: z.string() })
    .parse(JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" })));
  if (!["127.0.0.1", "localhost"].includes(new URL(config.API_URL).hostname)) throw new Error("Hosting tests require local Supabase.");
  const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const email = `hosting-bank-${crypto.randomUUID()}@example.test`, password = `test-${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error("Cannot create isolated hosting test user.");
  const uid = created.data.user.id;
  async function cleanup() {
    const deleted = await admin.auth.admin.deleteUser(uid);
    if (deleted.error) throw new Error("Hosting test-user cleanup failed.");
  }
  const id = crypto.randomUUID();
  try {
    await page.route("**/rest/v1/rpc/app_banking", route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({
        connections: [{
          id, institution_name: "Example Bank", environment: "production", status: "needs_reconnect",
          import_start: "2026-09-01", connected_at: "2026-09-01T12:00:00Z", last_synced_at: null,
          error_code: "ITEM_LOGIN_REQUIRED", initial_complete: true, historical_complete: false,
          accounts: [{ account_id: "checking", name: "Everyday checking", mask: "1234", type: "depository", subtype: "checking", selected: true }],
        }],
        reviews: [{
          id: crypto.randomUUID(), connection_id: id, version: 1, reason: "invalid",
          record: null, error: "INVALID_CENT_PRECISION", transaction_id: null, candidates: [],
        }],
        pending: [], review_total: 1, pending_total: 0,
      }),
    }));
    await page.goto("/connections");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Welcome back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your bank connections" })).toBeVisible();
    await expect(page.getByText("Reconnect required", { exact: true })).toBeVisible();
    await expect(page.getByText("Your bank needs you to sign in again. Reconnect to continue importing transactions.")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Sandbox test instructions" })).toHaveCount(0);
    await expect(page.getByText(/Cutover|October 3, 2026|October 4|Local development|local catch-up|Plaid webhook|user_transactions_dynamic|MONTHLY INSIGHTS/)).toHaveCount(0);
    await expect(page.getByText("ITEM_LOGIN_REQUIRED", { exact: true })).not.toBeVisible();
    await expect(page.getByLabel("Import transactions starting")).toHaveValue(await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }));
    await page.screenshot({ path: testInfo.outputPath("connections-production-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("fractions of a cent");
    await expect(page.getByText("INVALID_CENT_PRECISION", { exact: true })).not.toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.getByRole("button", { name: "Close Review bank activity" }).click();
    await page.locator("#main-content").focus();
    await page.setViewportSize({ width: 360, height: 800 });
    const mobile = await new AxeBuilder({ page }).analyze();
    expect(mobile.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("connections-production-mobile.png"), fullPage: true });
  } finally {
    await cleanup();
  }
});

test("production recovery messaging is not local-only", async ({ page }) => {
  await page.route("**/auth/v1/recover**", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/budget");
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("hosting-test@example.test");
  await page.getByRole("button", { name: "Reset your password", exact: true }).click();
  await expect(page.getByText("Password reset requested. If your account can receive email, check your inbox for a recovery link.")).toBeVisible();
  await expect(page.getByText(/Mailpit/)).toHaveCount(0);
});
