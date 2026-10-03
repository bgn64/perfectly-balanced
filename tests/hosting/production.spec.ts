import { test, expect } from "@playwright/test";

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

test("production recovery messaging is not local-only", async ({ page }) => {
  await page.route("**/auth/v1/recover**", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/budget");
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("hosting-test@example.test");
  await page.getByRole("button", { name: "Reset your password", exact: true }).click();
  await expect(page.getByText("Password reset requested. If your account can receive email, check your inbox for a recovery link.")).toBeVisible();
  await expect(page.getByText(/Mailpit/)).toHaveCount(0);
});
