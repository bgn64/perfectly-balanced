import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { test as base, expect } from "@playwright/test";
import { z } from "zod";
import { makeClient, SupabaseRepository } from "@balanced/data";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Json } from "../../packages/data/src/database.types";
import { categoryActual, money } from "@balanced/domain";

const config = z.object({ API_URL: z.string(), ANON_KEY: z.string(), SERVICE_ROLE_KEY: z.string() })
  .parse(JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" })));
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function cleanupUser(id: string) {
  const cleanup = await admin.auth.admin.deleteUser(id);
  if (cleanup.error) throw new Error(cleanup.error.message);
}
const test = base.extend<{ user: { email: string; password: string } }>({
  user: async ({ browserName: _browserName }, use) => {
    const email = `e2e-${crypto.randomUUID()}@example.test`, password = `test-${crypto.randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? "Test account creation failed");
    try { await use({ email, password }); }
    finally { await cleanupUser(data.user.id); }
  },
});
test.beforeEach(async ({ page, user }) => {
  await page.goto("/budget?month=2026-10");
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Welcome back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your monthly budget" })).toBeVisible();
});
async function loadDemo(page: Page) {
  await page.getByRole("button", { name: "Budget actions" }).click();
  await page.getByRole("menuitem", { name: "Load demo data" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Load demo data" }).click();
  await expect(page.getByText("Demo data loaded.", { exact: true })).toBeVisible();
}
async function testRepository(user: { email: string; password: string }) {
  const client = makeClient(config.API_URL, config.ANON_KEY);
  const { error } = await client.auth.signInWithPassword(user);
  if (error) throw new Error(error.message);
  return new SupabaseRepository(client);
}
async function checkAccessibility(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
}

test("bank connections, pending totals, overlap review and retained disconnection", async ({ page, user }, testInfo) => {
  const repo = await testRepository(user);
  const auth = await repo.client.auth.getUser();
  if (auth.error || !auth.data.user) throw new Error("Test authentication unavailable.");
  const uid = auth.data.user.id;
  async function op(action: string, payload: Json) {
    const result = await admin.rpc("plaid_admin",{ p_action:action,p_payload:payload });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  }
  const intent = z.string().parse(await op("intent",{ owner_id:uid,import_start:"2026-10-04" }));
  await op("exchange_claim",{ owner_id:uid,intent_id:intent });
  const account={ account_id:"e2e-checking",name:"Test checking",mask:"1234",type:"depository",subtype:"checking" };
  const id=z.string().parse(await op("create",{ owner_id:uid,intent_id:intent,item_id:`e2e-${uid}`,
    access_token:`fixture-${uid}`,environment:"sandbox",institution_name:"Test bank",accounts:[account] }));
  await page.route("**/functions/v1/plaid-api",async route => {
    const headers={ "Access-Control-Allow-Origin":"http://127.0.0.1:5173","Access-Control-Allow-Headers":"authorization, apikey, x-client-info, content-type","Access-Control-Allow-Methods":"POST, OPTIONS" };
    if (route.request().method()==="OPTIONS") return route.fulfill({ status:204,headers });
    const body=route.request().postDataJSON();
    if (body.action==="accounts") await op("accounts",{ owner_id:uid,id,accounts:body.accounts });
    else if (body.action==="disconnect") {
      await op("disconnect_start",{ owner_id:uid,id });
      await op("disconnect_finish",{ owner_id:uid,id });
    } else return route.fulfill({ status:503,headers,contentType:"application/json",body:JSON.stringify({ error:"BACKEND_CONFIGURATION_MISSING" }) });
    await route.fulfill({ status:200,headers,contentType:"application/json",body:JSON.stringify({ queued:true }) });
  });
  await page.getByRole("link",{ name:"Connections",exact:true }).click();
  await expect(page.getByRole("heading",{ name:"Your bank connections" })).toBeVisible();
  await expect(page.getByLabel("Selected month")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Sandbox test instructions" })).toBeVisible();
  await expect(page.getByText("Sandbox only - use test credentials.", { exact: true })).toBeVisible();
  await expect(page.getByText("user_transactions_dynamic", { exact: true })).not.toBeVisible();
  const sandboxSetup = page.locator(".bank-sandbox summary");
  await sandboxSetup.focus();
  await sandboxSetup.press("Enter");
  await expect(page.getByText("user_transactions_dynamic", { exact: true })).toBeVisible();
  await sandboxSetup.press("Enter");
  await expect(page.getByText("user_transactions_dynamic", { exact: true })).not.toBeVisible();
  await expect(page.locator(".bank-introduction p, .bank-connect-form p")).toHaveCount(0);
  await expect(page.getByLabel("Import from", { exact: true })).toBeVisible();
  await expect(page.getByText(/Cutover finished|October 3, 2026|local catch-up/)).toHaveCount(0);
  await expect(page.getByRole("heading",{ name:"Test bank" })).toBeVisible();
  await page.getByRole("button",{ name:"Connect a bank" }).click();
  await expect(page.getByRole("alert")).toContainText("Bank connections are not available yet");
  await page.getByRole("button",{ name:"Select accounts",exact:true }).click();
  await page.getByLabel("Test checking").check();
  await page.getByRole("button",{ name:"Save accounts and start sync" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await repo.mutate({ action:"manual",description:"E2E overlap",merchant:"E2E overlap",amount_cents:-1234,original_date:"2026-10-04" });
  const claimed=z.object({ lease:z.string() }).parse(await op("claim",{ id,environment:"sandbox" }));
  const value={ transaction_id:"e2e-posted",account_id:account.account_id,pending_transaction_id:null,pending:false,
    original_date:"2026-10-04",amount_cents:-1234,description:"E2E overlap",merchant:"E2E overlap" };
  await op("stage",{ id,lease:claimed.lease,changes:[
    { source_id:value.transaction_id,value,removed:false,error:null },
    { source_id:"e2e-pending",value:{ ...value,transaction_id:"e2e-pending",pending:true,description:"E2E pending" },removed:false,error:null },
  ],next_cursor:"e2e-cursor",has_more:false });
  await page.reload();
  await expect(page.getByRole("heading",{ name:"Review activity (1)" })).toBeVisible();
  await expect(page.getByRole("heading",{ name:"Pending activity (1)" })).toBeVisible();
  await expect(page.getByText("Not in totals", { exact: true })).toHaveCount(2);
  expect((await repo.month("2026-10")).transactions).toHaveLength(1);
  await page.getByRole("button",{ name:"Review",exact:true }).click();
  const review = page.getByRole("dialog", { name: "Review bank activity" });
  await expect(review.locator(".bank-comparison-facts")).toContainText("Current amount");
  await expect(review.locator(".bank-comparison-facts")).toContainText("-$12.34");
  await expect(review.locator(".bank-comparison-facts")).toContainText("Original date");
  await expect(review.getByText("Categories and splits kept", { exact: true })).toBeVisible();
  await checkAccessibility(page);
  await page.getByRole("button",{ name:"Match existing transaction" }).click();
  await expect(page.getByRole("heading",{ name:"Review activity (0)" })).toBeVisible();
  expect((await repo.month("2026-10")).transactions).toHaveLength(1);
  await page.getByRole("link",{ name:"Transactions",exact:true }).click();
  await page.getByRole("button",{ name:"Open E2E overlap details" }).click();
  await expect(page.getByText("Test bank - Test checking (...1234)",{ exact:true })).toBeVisible();
  await page.getByRole("button",{ name:"Close Transaction details" }).click();
  await page.getByRole("link",{ name:"Connections",exact:true }).click();
  await page.setViewportSize({ width:390,height:844 });
  await checkAccessibility(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({ path:testInfo.outputPath("connections-mobile.png"),fullPage:true });
  await page.getByRole("button",{ name:"Disconnect",exact:true }).click();
  await page.getByRole("alertdialog").getByRole("button",{ name:"Disconnect bank" }).click();
  await expect(page.getByText("Disconnected",{ exact:true })).toBeVisible();
  expect((await repo.month("2026-10")).transactions).toHaveLength(1);
  expect((await repo.banking()).pending).toEqual([]);
});

test("categorize, split, exclude, restore, drill down, move dates and persist", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Budget actions" }).click();
  await page.getByRole("menuitem", { name: "Load demo data" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Load demo data" }).click();
  await expect(page.getByText("Demo data loaded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit planned Groceries" })).toHaveText("$450.00");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await page.getByLabel("Search", { exact: true }).fill("More groceries");
  const row = page.locator(".transaction-row").filter({ has: page.getByRole("button", { name: "Demo: More groceries", exact: true }) });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Use Groceries" }).click();
  await expect(row.getByRole("combobox").first()).not.toHaveValue("");
  await row.getByRole("button", { name: "Open Demo: More groceries details" }).click();
  await page.getByRole("button", { name: "Edit splits" }).click();
  const dialog = page.getByRole("dialog", { name: "Split transaction", exact: true });
  await dialog.getByLabel("Amount for split 1").fill("-75.75");
  await dialog.getByRole("button", { name: "Add split" }).click();
  await dialog.getByLabel("Amount for split 2").fill("10.00");
  const sheetLayer = await page.locator(".modal.sheet").evaluate(el => Number(getComputedStyle(el).zIndex));
  const splitBackdropLayer = await page.locator(".overlay").last().evaluate(el => Number(getComputedStyle(el).zIndex));
  expect(splitBackdropLayer).toBeGreaterThan(sheetLayer);
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("split-dialog-desktop.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Save splits" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Close Transaction details" }).click();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  const spending = page.locator(".report-card").filter({ hasText: "Actual spending" });
  const income = page.locator(".report-card").filter({ hasText: "Actual income" });
  await expect(spending.getByRole("heading", { level: 2 })).toHaveText("$1,710.08");
  await expect(income.getByRole("heading", { level: 2 })).toHaveText("$4,210.00");
  await page.screenshot({ path: testInfo.outputPath("reports-desktop.png"), fullPage: true });
  await spending.getByRole("button", { name: /Essentials.*1,645.59/ }).focus();
  await page.keyboard.press("Enter");
  await spending.getByRole("button", { name: /Groceries.*145.59/ }).focus();
  await page.keyboard.press("Enter");
  const activity = page.getByRole("dialog", { name: "Groceries transactions" });
  await expect(activity).toBeVisible();
  await expect(activity.getByRole("button", { name: "Open Demo: More groceries details" })).toBeVisible();
  await expect(activity.locator(".activity-summary")).toContainText("$145.59");
  await expect(activity.locator(".activity-summary p")).toHaveCount(0);
  await expect(activity.getByText("Includes excluded", { exact: true })).toHaveCount(0);
  const splitActivity = activity.locator(".activity-open").filter({ hasText: "Demo: More groceries" });
  await expect(splitActivity).toContainText("Transaction total -$65.75");
  await expect(splitActivity).toContainText("2 splits");
  await expect(splitActivity.locator(".activity-value")).toContainText("$75.75");
  const singleActivity = activity.locator(".activity-open").filter({ hasText: "Demo: Weekly groceries" });
  await expect(singleActivity).not.toContainText("Transaction total");
  await expect(singleActivity.locator(".activity-value")).toContainText("Category amount");
  await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
  await page.getByLabel("Include uncategorized in actual totals").uncheck();
  await expect(income.getByRole("heading", { level: 2 })).toHaveText("$4,200.00");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await page.getByLabel("Search", { exact: true }).fill("More groceries");
  await row.getByRole("button", { name: "Open Demo: More groceries details" }).click();
  await page.getByRole("button", { name: "Exclude from budget & reports", exact: true }).click();
  await expect(row).not.toBeVisible();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Excluded transactions").selectOption("only");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Open Demo: More groceries details" }).click();
  await page.getByRole("button", { name: "Restore to budget & reports" }).click();
  await expect(row).not.toBeVisible();
  await page.getByLabel("Excluded transactions").selectOption("hide");
  await row.getByRole("button", { name: "Open Demo: More groceries details" }).click();
  await page.getByLabel("Effective date").fill("2026-11-01");
  await page.getByRole("button", { name: "Change effective date" }).click();
  await expect(row).not.toBeVisible();
  await page.getByLabel("Selected month").fill("2026-11");
  await expect(row).toBeVisible();
  await page.getByRole("link", { name: "Budget", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unplanned activity" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unplanned activity" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("manual budgets, CSV validation/import, copy and mobile navigation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  const sectionForm = page.getByRole("dialog", { name: "Add a budget section" });
  await sectionForm.getByLabel("Section name").fill("Living");
  await sectionForm.getByRole("button", { name: "Add section" }).click();
  const living = page.locator(".budget-section").filter({ has: page.getByRole("heading", { name: "Living", exact: true }) });
  await living.getByRole("button", { name: "Add category to Living" }).click();
  const categoryDialog = page.getByRole("dialog", { name: "Add category to Living" });
  await categoryDialog.getByLabel("Category name", { exact: true }).fill("Food");
  await categoryDialog.getByLabel("Planned dollars").fill("100.00");
  await categoryDialog.getByRole("button", { name: "Add category", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit planned Food" })).toHaveText("$100.00");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await page.getByRole("button", { name: "Add transaction", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("Manual coffee");
  await page.getByLabel("Signed dollars").fill("-5.25");
  await page.getByRole("dialog").getByRole("button", { name: "Add transaction", exact: true }).click();
  await expect(page.getByRole("button", { name: "Manual coffee", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import CSV" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import transactions" });
  await expect(importDialog.locator(".import-instructions p")).toHaveCount(0);
  await expect(importDialog.getByRole("link", { name: "Download CSV template" })).toBeVisible();
  await expect(importDialog.locator(".import-instructions")).toContainText("1,000 rows");
  await page.getByLabel("Choose CSV").setInputFiles({
    name: "invalid.csv", mimeType: "text/csv",
    buffer: Buffer.from("date,description,amount\n2026-02-30,Invalid,-1.00"),
  });
  await expect(page.getByText("Fix the row errors below before importing.")).toBeVisible();
  await page.getByLabel("Choose CSV").setInputFiles({
    name: "valid.csv", mimeType: "text/csv",
    buffer: Buffer.from("date,description,amount\n2026-10-02,Imported lunch,-12.50\n2026-10-02,Imported lunch,-12.50"),
  });
  await page.getByRole("button", { name: "Import 2 transactions" }).click();
  await expect(page.getByRole("button", { name: "Imported lunch", exact: true })).toHaveCount(2);
  await page.getByLabel("Search", { exact: true }).fill("Manual coffee");
  const row = page.locator(".transaction-row").filter({ hasText: "Manual coffee" });
  await row.getByRole("combobox").first().selectOption({ label: "Food" });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption({ label: "Food" });
  await expect(row).toBeVisible();
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption("");
  await expect(row).toBeVisible();
  await page.getByRole("link", { name: "Budget", exact: true }).click();
  const food = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Food", exact: true }) });
  await expect(food).toContainText("$94.75");
  await page.getByLabel("Selected month").fill("2026-11");
  await page.getByRole("button", { name: "Budget actions" }).click();
  await page.getByRole("menuitem", { name: "Copy budget" }).click();
  await page.getByLabel("Copy from month").fill("2026-10");
  await page.getByRole("button", { name: "Copy budget", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit planned Food" })).toHaveText("$100.00");
  await expect(page.getByRole("row").filter({ has: page.getByRole("button", { name: "Food", exact: true }) })).toContainText("$100.00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("budget-mobile.png"), fullPage: true });
});

test("sign-up and local password-reset email", async ({ page, user }, testInfo) => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.screenshot({ path: testInfo.outputPath("auth-desktop.png"), fullPage: true });
  await checkAccessibility(page);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email", { exact: true }).fill(user.email);
  await page.getByRole("button", { name: "Reset your password", exact: true }).click();
  await expect(page.getByText("Password reset email sent. Open the local Mailpit inbox.")).toBeVisible();
  const mailbox = z.object({ messages: z.array(z.object({
    ID: z.string(), To: z.array(z.object({ Address: z.string() })),
  })) }).parse(await (await page.request.get("http://127.0.0.1:54324/api/v1/messages")).json());
  const message = mailbox.messages.find(m => m.To.some(to => to.Address === user.email));
  expect(message).toBeDefined();
  const content = z.object({ HTML: z.string() }).parse(await (await page.request.get(`http://127.0.0.1:54324/api/v1/message/${message!.ID}`)).json());
  const recoveryLink = /href="([^"]+)"/.exec(content.HTML)?.[1].replaceAll("&amp;", "&");
  if (!recoveryLink) throw new Error("Password reset email contains no link.");
  await page.goto(recoveryLink);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(`reset-${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Choose a new password", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your monthly budget" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  const email = `e2e-signup-${crypto.randomUUID()}@example.test`;
  const password = `test-${crypto.randomUUID()}`;
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes("/auth/v1/signup") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create your account", exact: true }).click(),
  ]);
  const created = z.object({ user: z.object({ id: z.string() }) }).parse(await response.json());
  try {
    await expect(page.getByRole("heading", { name: "Your monthly budget" })).toBeVisible();
  } finally { await cleanupUser(created.user.id); }
});

test("explicit money editing, cancellation, errors and unsaved navigation", async ({ page, user }, testInfo) => {
  await loadDemo(page);
  const repo = await testRepository(user);
  const trigger = page.getByRole("button", { name: "Edit planned Groceries" });
  await expect(page.getByLabel("Planned Groceries", { exact: true })).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const input = page.getByLabel("Planned Groceries", { exact: true });
  await expect(input).toBeFocused();
  await input.fill("500.29");
  await input.press("Tab");
  expect((await repo.month("2026-10")).budget_categories.find(c => c.name === "Groceries")?.planned_cents).toBe(45000);
  await input.focus(); await input.press("Escape");
  await expect(trigger).toHaveText("$450.00");
  await expect(trigger).toBeFocused();
  await trigger.click(); await input.fill("525.00"); await input.press("Enter");
  await expect(trigger).toHaveText("$525.00");
  expect((await repo.month("2026-10")).budget_categories.find(c => c.name === "Groceries")?.planned_cents).toBe(52500);
  await page.route("**/rest/v1/rpc/app_mutate", route => route.fulfill({ status: 500, json: { message: "Connection interrupted. Please retry." } }));
  await trigger.click(); await input.fill("550.25"); await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Connection interrupted");
  await expect(input).toHaveValue("550.25");
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("failed-money-edit-desktop.png"), fullPage: true });
  expect((await repo.month("2026-10")).budget_categories.find(c => c.name === "Groceries")?.planned_cents).toBe(52500);
  await page.unroute("**/rest/v1/rpc/app_mutate");
  await input.press("Escape");
  await trigger.click(); await input.fill("-1.00"); await input.press("Enter");
  await expect(page.getByText("Planned amounts must be nonnegative.")).toBeVisible();
  await expect(input).toHaveValue("-1.00"); await input.press("Escape");
  await trigger.click(); await input.fill("999.00");
  await page.getByRole("button", { name: "Cancel planned Groceries" }).click();
  await expect(trigger).toHaveText("$525.00");
  await trigger.click(); await input.fill("333.00");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "Discard unsaved changes?" })).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(input).toHaveValue("333.00");
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await page.getByRole("button", { name: "Discard and continue" }).click();
  await expect(page.getByRole("heading", { name: "Your transactions" })).toBeVisible();
  expect((await repo.month("2026-10")).budget_categories.find(c => c.name === "Groceries")?.planned_cents).toBe(52500);
  await page.getByRole("link", { name: "Budget", exact: true }).click();
  await trigger.click(); await input.fill("444.00");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(input).toHaveValue("444.00");
  expect((await repo.month("2026-10")).budget_categories.find(c => c.name === "Groceries")?.planned_cents).toBe(52500);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard and continue" }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
});

test("menu management and accessible draft dialogs", async ({ page, user }) => {
  await loadDemo(page);
  await page.getByRole("button", { name: "Manage category Groceries" }).click();
  await page.getByRole("menuitem", { name: "Rename category" }).press("Enter");
  const rename = page.getByRole("dialog", { name: "Rename category", exact: true });
  const name = rename.getByLabel("Category name");
  await expect(name).toBeFocused();
  await name.fill("Food shopping");
  await rename.getByRole("button", { name: "Close Rename category" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(name).toHaveValue("Food shopping");
  await rename.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: "Food shopping", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage category Food shopping" }).click();
  await page.getByRole("menuitem", { name: "Remove from month" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove category" }).click();
  await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("Reassign");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a budget section" });
  await dialog.getByLabel("Section name").fill("Discarded section");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Discarded section" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add section", exact: true })).toBeFocused();
  await expect(page.getByLabel("Permanent Income section")).toBeVisible();
  await expect(page.getByRole("button", { name: "Manage section Income" })).toHaveCount(0);
  const essentials = page.locator(".budget-section").filter({ has: page.getByRole("heading", { name: "Essentials", exact: true }) });
  const initialOrder = await essentials.locator(".category-inspect").allTextContents();
  await page.getByRole("button", { name: "Manage category Food shopping" }).click();
  await page.getByRole("menuitem", { name: initialOrder[0] === "Food shopping" ? "Move down" : "Move up", exact: true }).click();
  await expect(essentials.locator(".category-inspect")).toHaveText([...initialOrder].reverse());
  await page.getByRole("button", { name: "Manage category Food shopping" }).click();
  await page.getByRole("menuitem", { name: "Archive category", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive category", exact: true }).click();
  await expect(page.locator(".budget-row").filter({ hasText: "Food shopping" }).getByText("Archived", { exact: true })).toBeVisible();
  const repo = await testRepository(user);
  let state = await repo.month("2026-10");
  const foodId = state.budget_categories.find(c => c.name === "Food shopping")!.category_id;
  expect(state.categories.find(c => c.id === foodId)?.archived).toBe(true);
  await page.getByRole("button", { name: "Add section", exact: true }).click();
  await dialog.getByLabel("Section name").fill("Reserve");
  await dialog.getByRole("button", { name: "Add section", exact: true }).click();
  await page.getByRole("button", { name: "Manage section Reserve" }).click();
  await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
  await expect(page.locator(".budget-section-header h2")).toHaveText(["Income", "Essentials", "Reserve", "Lifestyle"]);
  await page.getByRole("button", { name: "Manage section Reserve" }).click();
  await page.getByRole("menuitem", { name: "Archive section", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive section", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add category to Reserve" })).toHaveCount(0);
  state = await repo.month("2026-10");
  expect(state.sections.find(s => s.name === "Reserve")?.archived).toBe(true);
  await page.getByRole("button", { name: "Manage section Reserve" }).click();
  await page.getByRole("menuitem", { name: "Remove from month", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove section", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reserve", exact: true })).toHaveCount(0);
});

test("desktop density and responsive financial visibility", async ({ page, user }, testInfo) => {
  test.setTimeout(90000);
  const repo = await testRepository(user);
  await repo.demo("2026-10");
  for (let i = 0; i < 12; i++) await repo.mutate({ action: "manual", description: `Neighborhood purchase ${i + 1}`, merchant: "Neighborhood shop", original_date: "2026-10-04", amount_cents: -(1000 + i * 137) });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Edit planned Groceries" })).toBeVisible();
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("budget-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page.locator(".transaction-row")).toHaveCount(19);
  await checkAccessibility(page);
  const visible = await page.locator(".transaction-row").evaluateAll(rows => rows.filter(row => {
    const rect = row.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }).length);
  expect(visible).toBeGreaterThanOrEqual(8);
  await page.screenshot({ path: testInfo.outputPath("transactions-desktop.png"), fullPage: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("link", { name: "Budget", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit planned Groceries" })).toBeVisible();
    const visibleBalances = await page.locator(".budget-row").evaluateAll(rows => rows.every(row => {
      const name = row.querySelector(".category-inspect")?.getBoundingClientRect(), balance = row.querySelector(".budget-remaining")?.getBoundingClientRect();
      return !!name && !!balance && name.left >= 0 && name.right <= window.innerWidth && balance.left >= 0 && balance.right <= window.innerWidth;
    }));
    expect(visibleBalances).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`budget-${viewport.width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.locator(".transaction-row")).toHaveCount(19);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`transactions-${viewport.width}.png`), fullPage: true });
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Actual activity" })).toBeVisible();
    await checkAccessibility(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`reports-${viewport.width}.png`), fullPage: true });
  }
});

test("signed report fallbacks, overspending and mobile transaction sheets", async ({ page, user }, testInfo) => {
  const repo = await testRepository(user);
  for (const name of ["Essentials", "Refunds"]) await repo.mutate({ action: "section_add", month: "2026-10", name });
  const sections = (await repo.month("2026-10")).sections;
  await repo.mutate({ action: "category_add", month: "2026-10", section_id: sections.find(s => s.name === "Essentials")!.id, name: "Groceries", planned_cents: 10000 });
  await repo.mutate({ action: "category_add", month: "2026-10", section_id: sections.find(s => s.name === "Refunds")!.id, name: "Store credit", planned_cents: 0 });
  await repo.mutate({ action: "manual", original_date: "2026-10-10", description: "Large grocery purchase", merchant: "Market", amount_cents: -20000 });
  await repo.mutate({ action: "manual", original_date: "2026-10-11", description: "Returned purchase", merchant: "Market", amount_cents: 5000 });
  let state = await repo.month("2026-10");
  for (const transaction of state.transactions) await repo.mutate({ action: "split", id: transaction.id, allocations: [{ category_id: state.categories.find(c => c.name === (transaction.amount_cents < 0 ? "Groceries" : "Store credit"))!.id, amount_cents: transaction.amount_cents }] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const grocery = page.locator(".budget-row").filter({ hasText: "Groceries" });
  await expect(grocery.locator(".budget-remaining")).toHaveText("Remaining-$100.00");
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("overspent-budget-mobile.png"), fullPage: true });
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await page.getByRole("button", { name: "Large grocery purchase", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Transaction details" });
  await expect(sheet).toBeVisible(); await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("transaction-sheet-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Close Transaction details" }).click();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  const spending = page.getByRole("region", { name: "Actual spending", exact: true });
  await expect(spending.getByRole("heading", { level: 2 })).toHaveText("$150.00");
  await expect(spending.locator(".chart")).toHaveCount(0);
  await expect(spending.locator(".chart-explanation")).toContainText("Signed breakdown");
  await expect(page.getByRole("region", { name: "Actual income", exact: true })).toContainText("No activity to report");
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("signed-reports-mobile.png"), fullPage: true });
  const refunds = spending.getByRole("button", { name: /Refunds.*-.*50.00/ });
  await refunds.scrollIntoViewIfNeeded();
  const beforeSigned = await spending.boundingBox();
  const beforePlan = (await page.locator(".report-group").last().boundingBox())!.y + await page.evaluate(() => window.scrollY);
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await refunds.click();
  expect((await spending.boundingBox())?.height).toBe(beforeSigned?.height);
  expect((await page.locator(".report-group").last().boundingBox())!.y + await page.evaluate(() => window.scrollY)).toBe(beforePlan);
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeScroll);
  await spending.getByRole("button", { name: /Store credit.*-.*50.00/ }).click();
  const activity = page.getByRole("dialog", { name: "Store credit transactions" });
  await expect(activity.locator(".activity-summary")).toContainText("-$50.00");
  await activity.getByRole("button", { name: "Open Returned purchase details" }).click();
  await page.getByRole("dialog", { name: "Transaction details", exact: true }).getByLabel("Category for Returned purchase split 1").selectOption("");
  await expect(page.getByRole("dialog", { name: "Transaction details", exact: true })).toHaveCount(0);
  await expect(activity).toBeVisible();
  await expect(activity.getByText("No transactions in this view", { exact: true })).toBeVisible();
  await activity.getByRole("button", { name: "Close Store credit transactions" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await repo.mutate({ action: "category_add", month: "2026-10", section_id: sections.find(s => s.kind === "income")!.id, name: "Net zero income", planned_cents: 0 });
  await repo.mutate({ action: "manual", original_date: "2026-10-12", description: "Income adjustment in", merchant: "", amount_cents: 5000 });
  await repo.mutate({ action: "manual", original_date: "2026-10-12", description: "Income adjustment out", merchant: "", amount_cents: -5000 });
  state = await repo.month("2026-10");
  for (const transaction of state.transactions.filter(t => t.description.startsWith("Income adjustment"))) await repo.mutate({ action: "split", id: transaction.id, allocations: [{ category_id: state.categories.find(c => c.name === "Net zero income")!.id, amount_cents: transaction.amount_cents }] });
  await page.reload();
  await page.getByLabel("Include uncategorized in actual totals").uncheck();
  const income = page.getByRole("region", { name: "Actual income", exact: true });
  await expect(income.getByRole("heading", { level: 2 })).toHaveText("$0.00");
  await expect(income.locator(".chart")).toHaveCount(0);
  await expect(income.locator(".chart-explanation")).toContainText("Zero total");
  const zeroHeight = (await income.boundingBox())?.height;
  await income.getByRole("button", { name: /Income.*0.00/ }).click();
  expect((await income.boundingBox())?.height).toBe(zeroHeight);
  await income.getByRole("button", { name: /Net zero income/ }).click();
  const zeroActivity = page.getByRole("dialog", { name: "Net zero income transactions" });
  await expect(zeroActivity.locator(".activity-summary")).toContainText("$0.00");
  await expect(zeroActivity.locator(".activity-list > li")).toHaveCount(2);
  await zeroActivity.getByRole("button", { name: "Close Net zero income transactions" }).click();
});

test("category inspection preserves context, exact details, drafts and focus after edits", async ({ page, user }, testInfo) => {
  await loadDemo(page);
  const repo = await testRepository(user);
  const initial = await repo.month("2026-10");
  await repo.mutate({ action: "split", id: initial.transactions.find(t => t.description === "Demo: More groceries")!.id, allocations: [{ category_id: initial.categories.find(c => c.name === "Groceries")!.id, amount_cents: -6575 }] });
  await page.reload();
  const launcher = page.getByRole("button", { name: "Groceries", exact: true });
  await launcher.focus();
  const url = page.url();
  const scroll = await page.evaluate(() => window.scrollY);
  await launcher.press("Enter");
  const activity = page.getByRole("dialog", { name: "Groceries transactions" });
  await expect(activity).toBeVisible();
  await expect(activity.locator(".activity-summary p")).toHaveCount(0);
  await expect(activity.getByText("Includes excluded", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(url);
  await checkAccessibility(page);
  await activity.getByRole("button", { name: "Open Demo: More groceries details" }).click();
  const details = page.getByRole("dialog", { name: "Transaction details", exact: true });
  await details.getByRole("button", { name: "Edit splits" }).click();
  const split = page.getByRole("dialog", { name: "Split transaction", exact: true });
  await split.getByLabel("Amount for split 1").fill("-1.00");
  await split.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(split).toBeVisible();
  await split.getByRole("button", { name: "Close Split transaction" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await details.getByRole("button", { name: "Exclude from budget & reports" }).click();
  await expect(details.getByText("Excluded from budget & reports", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Close Transaction details" }).click();
  await expect(activity.getByText("Excluded", { exact: true })).toBeVisible();
  await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
  await expect(launcher).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  const spending = page.getByRole("region", { name: "Actual spending", exact: true });
  await spending.getByRole("button", { name: /Essentials/ }).click();
  await spending.getByRole("button", { name: /Groceries/ }).click();
  await expect(activity).toBeVisible();
  await expect(activity.getByRole("button", { name: "Open Demo: More groceries details" })).toHaveCount(0);
  await activity.getByRole("button", { name: "Open Demo: Weekly groceries details" }).click();
  await details.getByLabel("Category for Demo: Weekly groceries split 1").selectOption("");
  await expect(details).toHaveCount(0);
  await expect(activity).toBeVisible();
  await expect(activity.getByRole("status").filter({ hasText: "no longer matches" })).toBeVisible();
  await expect(activity.locator(".results-heading")).toBeFocused();
  await expect(activity.getByRole("button", { name: "Open Demo: Weekly groceries details" })).toHaveCount(0);
  await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
  await expect(spending.locator(".breadcrumbs")).toContainText("Essentials");
  await page.screenshot({ path: testInfo.outputPath("context-preserving-reports.png"), fullPage: true });
  await repo.mutate({ action: "exclude", id: initial.transactions.find(t => t.description === "Demo: More groceries")!.id, excluded: false });
  await repo.mutate({ action: "date", id: initial.transactions.find(t => t.description === "Demo: More groceries")!.id, date: "2026-11-01" });
  await page.getByRole("link", { name: "Budget", exact: true }).click();
  await page.getByLabel("Selected month").fill("2026-11");
  const unplanned = page.locator(".unplanned-panel");
  await unplanned.getByRole("button", { name: "Groceries", exact: true }).click();
  await expect(activity).toBeVisible();
  await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
  await expect(unplanned.getByRole("button", { name: "Groceries", exact: true })).toBeFocused();
});

test("category panel paginates full allocation totals and recovers errors and depleted pages", async ({ page, user }, testInfo) => {
  test.setTimeout(90000);
  await loadDemo(page);
  const repo = await testRepository(user);
  const state = await repo.month("2026-10");
  const categoryId = state.categories.find(c => c.name === "Groceries")!.id;
  await repo.import(crypto.randomUUID().replaceAll("-", "").repeat(2), Array.from({ length: 31 }, (_, i) => ({
    original_date: "2026-10-20", description: "Identical shop", merchant: "Shop", amount_cents: -(i + 1) * 100, external_id: crypto.randomUUID(),
  })));
  const imported = (await repo.month("2026-10")).transactions.filter(t => t.description === "Identical shop");
  for (const t of imported) await repo.mutate({ action: "split", id: t.id, allocations: [{ category_id: categoryId, amount_cents: t.amount_cents }] });
  await page.reload();
  const net = money(-categoryActual(await repo.month("2026-10"), categoryId));
  const launcher = page.getByRole("button", { name: "Groceries", exact: true });
  await page.route("**/rest/v1/rpc/app_page", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Inspection temporarily unavailable" }) }));
  await launcher.click();
  const activity = page.getByRole("dialog", { name: "Groceries transactions" });
  await expect(activity.getByRole("alert")).toContainText("Inspection temporarily unavailable", { timeout: 15000 });
  await page.unroute("**/rest/v1/rpc/app_page");
  await activity.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(activity.locator(".activity-list > li")).toHaveCount(30);
  await expect(activity.locator(".activity-summary")).toContainText(net);
  const firstId = await activity.locator(".activity-list > li").first().getAttribute("data-transaction-id");
  const expected = imported.find(t => t.id === firstId)!;
  await activity.getByRole("button", { name: "Open Identical shop details", exact: true }).first().click();
  const details = page.getByRole("dialog", { name: "Transaction details", exact: true });
  await expect(details.locator(".detail-amount")).toHaveText(money(expected.amount_cents));
  await details.getByRole("button", { name: "Close Transaction details" }).click();
  await activity.getByRole("button", { name: "Next", exact: true }).click();
  await expect(activity.locator(".activity-list > li")).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await activity.locator(".activity-open").last().click();
    await details.getByLabel("Effective date").fill("2026-11-01");
    await details.getByRole("button", { name: "Change effective date" }).click();
    await expect(details).toHaveCount(0);
  }
  await expect(activity.locator(".pagination")).toContainText("1-30 of 30");
  await expect(activity.locator(".activity-list > li")).toHaveCount(30);
  await page.setViewportSize({ width: 360, height: 800 });
  await checkAccessibility(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("category-transactions-mobile.png"), fullPage: true });
  await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
  await page.getByLabel("Selected month").fill("2026-11");
  await page.getByLabel("Selected month").fill("2026-10");
  await expect(activity).toHaveCount(0);
});

test("report drill-down keeps chart and lower cards stable across responsive layouts", async ({ page, user }, testInfo) => {
  test.setTimeout(90000);
  await loadDemo(page);
  const repo = await testRepository(user);
  const sectionId = (await repo.month("2026-10")).sections.find(s => s.name === "Essentials")!.id;
  for (let i = 0; i < 12; i++) await repo.mutate({ action: "category_add", month: "2026-10", section_id: sectionId, name: `Long household category name for layout testing ${i}`, planned_cents: 100 });
  await repo.mutate({ action: "manual", description: "Long breakdown fixture", merchant: "", amount_cents: -1200, original_date: "2026-10-01" });
  const state = await repo.month("2026-10");
  await repo.mutate({ action: "split", id: state.transactions.find(t => t.description === "Long breakdown fixture")!.id, allocations: state.categories.filter(c => c.name.startsWith("Long household")).map(c => ({ category_id: c.id, amount_cents: -100 })) });
  await page.reload();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  const spending = page.getByRole("region", { name: "Actual spending", exact: true });
  const plan = page.getByRole("region", { name: "Planned spending", exact: true });
  async function geometry() {
    const card = await spending.boundingBox(), chart = await spending.locator(".chart").boundingBox(), lower = await page.locator(".report-group").last().boundingBox();
    if (!card || !chart || !lower) throw new Error("Report geometry unavailable.");
    return { card, chart, lower };
  }
  for (const width of [1440, 1280, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await spending.getByRole("button", { name: "All sections", exact: true }).click();
    const before = await geometry();
    await spending.getByRole("button", { name: /Essentials/ }).click();
    const after = await geometry();
    for (const key of ["card", "chart", "lower"] as const) {
      for (const dimension of ["x", "y", "width", "height"] as const) expect(Math.abs(before[key][dimension] - after[key][dimension])).toBeLessThanOrEqual(1);
    }
    expect(await spending.locator(".legend").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const category = spending.getByRole("button", { name: /Groceries/ });
    await category.scrollIntoViewIfNeeded();
    const categoryScroll = await page.evaluate(() => window.scrollY);
    const legendScroll = await spending.locator(".legend").evaluate(el => el.scrollTop);
    await category.click();
    const activity = page.getByRole("dialog", { name: "Groceries transactions" });
    await expect(activity).toBeVisible();
    await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
    await expect(category).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(categoryScroll);
    expect(await spending.locator(".legend").evaluate(el => el.scrollTop)).toBe(legendScroll);
    const closed = await geometry();
    expect(Math.abs(closed.lower.y - before.lower.y)).toBeLessThanOrEqual(1);
    await spending.getByRole("button", { name: "All sections", exact: true }).click();
    const returned = await geometry();
    expect(Math.abs(returned.chart.y - before.chart.y)).toBeLessThanOrEqual(1);
    await plan.getByRole("button", { name: /Essentials/ }).click();
    await plan.getByRole("button", { name: /Groceries/ }).click();
    const planned = page.getByRole("dialog", { name: "Groceries planned amount" });
    await expect(planned.locator(".planned-detail")).toContainText("Planned");
    await expect(planned.locator(".planned-detail strong")).toHaveText("$450.00");
    await expect(planned.locator(".modal-body p")).toHaveCount(0);
    await planned.getByRole("button", { name: "Close Groceries planned amount" }).click();
    await plan.getByRole("button", { name: "All sections", exact: true }).click();
    await checkAccessibility(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`stable-reports-${width}.png`), fullPage: true });
  }
  async function clickWedge() {
    const wedge = spending.locator(".recharts-pie-sector path").first();
    await wedge.scrollIntoViewIfNeeded();
    const point = await wedge.evaluate(el => {
      if (!(el instanceof SVGGeometryElement)) throw new Error("Pie wedge geometry unavailable.");
      const bounds = el.getBBox(), matrix = el.getScreenCTM();
      if (!matrix) throw new Error("Pie wedge transform unavailable.");
      for (let x = bounds.x + 5; x < bounds.x + bounds.width; x += 5) {
        for (let y = bounds.y + 5; y < bounds.y + bounds.height; y += 5) {
          if (el.isPointInFill(new DOMPoint(x, y))) {
            const screen = new DOMPoint(x, y).matrixTransform(matrix);
            return { x: screen.x, y: screen.y };
          }
        }
      }
      throw new Error("No clickable point inside pie wedge.");
    });
    await page.mouse.click(point.x, point.y);
  }
  await clickWedge();
  await expect(spending.locator(".breadcrumbs")).not.toContainText("Overview");
  await clickWedge();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("signed-in screens use concise labels and actions instead of instructional paragraphs", async ({ page }, testInfo) => {
  await expect(page.getByRole("heading", { name: "No budget yet" })).toBeVisible();
  await expect(page.locator(".empty-state p")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add your first section" })).toBeVisible();
  await loadDemo(page);
  await expect(page.locator(".workspace-header p.muted, .feature-toolbar > span")).toHaveCount(0);
  await page.getByRole("button", { name: "Groceries", exact: true }).click();
  const activity = page.getByRole("dialog", { name: "Groceries transactions" });
  await expect(activity.locator(".activity-summary")).toContainText("Net spent");
  await expect(activity.locator(".activity-summary")).toContainText("$69.84");
  await expect(activity.locator(".activity-summary p")).toHaveCount(0);
  await activity.getByRole("button", { name: "Open Demo: Weekly groceries details" }).click();
  const details = page.getByRole("dialog", { name: "Transaction details", exact: true });
  await expect(details.locator(".detail-section > p.muted")).toHaveCount(0);
  await expect(details.getByLabel("Effective date", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Exclude from budget & reports", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Edit splits" })).toBeVisible();
  await details.getByRole("button", { name: "Close Transaction details" }).click();
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("concise-category-panel.png"), fullPage: true });
  await activity.getByRole("button", { name: "Close Groceries transactions" }).click();
  await page.getByRole("link", { name: "Transactions", exact: true }).click();
  await expect(page.locator(".workspace-header p.muted, .feature-toolbar > span")).toHaveCount(0);
  await page.getByRole("button", { name: "Add transaction", exact: true }).click();
  const manual = page.getByRole("dialog", { name: "Add transaction", exact: true });
  await expect(manual).toContainText("Money in (+), money out (-).");
  await expect(manual.getByLabel("Signed dollars")).toBeVisible();
  await manual.getByRole("button", { name: "Close Add transaction" }).click();
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(page.locator(".report-hint, .report-footnote, .report-group-header > span")).toHaveCount(0);
  await expect(page.getByLabel("Include uncategorized in actual totals")).toBeVisible();
  await page.getByRole("link", { name: "Connections", exact: true }).click();
  await expect(page.locator(".bank-introduction p, .bank-connect-form p, .bank-card .empty-state p")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No banks connected yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect a bank", exact: true })).toBeVisible();
  await expect(page.getByText("Sandbox only - use test credentials.", { exact: true })).toBeVisible();
  await expect(page.getByText("user_transactions_dynamic", { exact: true })).not.toBeVisible();
  await checkAccessibility(page);
  await page.screenshot({ path: testInfo.outputPath("concise-connections.png"), fullPage: true });
});
