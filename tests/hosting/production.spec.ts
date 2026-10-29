import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("private deep links, disabled signup and administrator recovery", async ({ page, request, baseURL }) => {
  for (const route of ["/budget", "/transactions", "/reports", "/connections"]) {
    await page.goto(`${route}?month=2026-09`);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create an account", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("household administrator");
  expect((await request.post("/api/budget", { headers: { Origin: baseURL! }, data: { operation: "month", month: "2026-10" } })).status()).toBe(401);
  expect((await request.post("/api/budget", { headers: { Origin: "https://untrusted.invalid" }, data: { operation: "month", month: "2026-10" } })).status()).toBe(403);
  expect((await request.post("/api/auth/sign-up/email", { headers: { Origin: baseURL! }, data: { name: "No signup", email: "no@example.test", password: "test-password-12345" } })).ok()).toBe(false);
});

test("login, real financial APIs, browser reports, private refresh and logout", async ({ page, baseURL }) => {
  await page.goto("/budget?month=2026-10");
  await page.getByLabel("Email", { exact: true }).fill("browser@example.test");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your monthly budget" })).toBeVisible();
  const mutate = async (command: unknown) => {
    const r = await page.request.post("/api/budget", { headers: { Origin: baseURL! }, data: { operation: "mutate", command } });
    expect(r.ok(), await r.text()).toBe(true);
  };
  await mutate({ action: "manual", description: "Container browser purchase", merchant: "Test market", original_date: "2026-10-05", amount_cents: -1234 });
  const monthResponse = await page.request.post("/api/budget", { headers: { Origin: baseURL! }, data: { operation: "month", month: "2026-10" } });
  expect(monthResponse.ok()).toBe(true);
  const month = await monthResponse.json();
  const transaction = month.transactions.find((t: { description: string }) => t.description === "Container browser purchase");
  expect(transaction).toBeDefined();
  const suggestion = await page.request.post("/api/budget", { headers: { Origin: baseURL! }, data: { operation: "suggest", id: transaction.id, month: "2026-10" } });
  expect(suggestion.ok()).toBe(true);
  expect(await suggestion.json()).toBeNull();
  expect(suggestion.headers()["cache-control"]).toBe("no-store");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page.getByText("Container browser purchase", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Container browser purchase", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your spending, in perspective" })).toBeVisible();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your bank connections" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Sandbox test instructions" })).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations.map(v => v.id)).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.goto("/transactions?month=2026-10");
  await expect(page.getByText("Container browser purchase", { exact: true })).toHaveCount(0);
  expect((await page.request.post("/api/budget", { headers: { Origin: baseURL! }, data: { operation: "month", month: "2026-10" } })).status()).toBe(401);
});
