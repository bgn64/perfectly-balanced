import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect, type Browser } from "@playwright/test";
import { z } from "zod";
import { bankingSchema } from "../../packages/domain/src/plaid.ts";
import type { Database } from "../../packages/data/src/database.types.ts";
const config=z.object({ API_URL:z.string(),ANON_KEY:z.string(),SERVICE_ROLE_KEY:z.string() })
  .parse(JSON.parse(execFileSync("npx",["supabase","status","-o","json"],{ encoding:"utf8" })));
if (!["127.0.0.1","localhost"].includes(new URL(config.API_URL).hostname)) throw new Error("Link smoke requires local Supabase.");
const admin=createClient(config.API_URL,config.SERVICE_ROLE_KEY,{ auth:{ persistSession:false } });
const client=createClient<Database>(config.API_URL,config.ANON_KEY,{ auth:{ persistSession:false } });
const email=`link-smoke-${crypto.randomUUID()}@example.test`,password=crypto.randomUUID();
const created=await admin.auth.admin.createUser({ email,password,email_confirm:true });
if (created.error || !created.data.user) throw new Error("Cannot create isolated Link test user.");
const uid=created.data.user.id;
let browser: Browser | undefined;
let signedIn=false;
async function cleanup() {
  try { await browser?.close(); }
  finally { await cleanupConnections(); }
}
async function cleanupConnections() {
  if (signedIn) {
    const state=await banking();
    for (const connection of state.connections.filter(c => c.status!=="disconnected")) {
      const result=await client.functions.invoke("plaid-api",{ body:{ action:"disconnect",id:connection.id },headers:{ Origin:"http://127.0.0.1:5173" } });
      if (result.error) throw new Error("Sandbox Link Item cleanup failed; operator cleanup required before deleting the test user.");
    }
  }
  await deleteUser();
}
async function banking() {
  const result=await client.rpc("app_banking",{});
  if (result.error) throw new Error("Cannot read isolated Link test connections.");
  return bankingSchema.parse(result.data);
}
async function deleteUser() {
  const result=await admin.auth.admin.deleteUser(uid);
  if (result.error) throw new Error("Link test user cleanup failed.");
}
try {
  const sign=await client.auth.signInWithPassword({ email,password });
  if (sign.error) throw new Error("Cannot sign in as isolated Link test user.");
  signedIn=true;
  browser=await chromium.launch();
  const page=await browser.newPage();
  await page.goto("http://127.0.0.1:5173/connections");
  await page.getByLabel("Email",{ exact:true }).fill(email);
  await page.getByLabel("Password",{ exact:true }).fill(password);
  await page.getByRole("button",{ name:"Welcome back",exact:true }).click();
  await expect(page.getByRole("heading",{ name:"Your bank connections" })).toBeVisible();
  const start=new Date(); start.setDate(start.getDate()-90);
  await page.getByLabel("Import transactions starting").fill(`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,"0")}-${String(start.getDate()).padStart(2,"0")}`);
  await page.getByRole("button",{ name:"Connect a bank" }).click();
  const frame=page.locator("iframe:visible").first();
  await expect(frame).toBeVisible({ timeout:30000 });
  await expect(frame.contentFrame().getByRole("button").first()).toBeVisible({ timeout:30000 });
  await frame.contentFrame().getByRole("button", { name: "Continue without phone number", exact: true }).click();
  await frame.contentFrame().getByRole("combobox",{ name:"Search",exact:true }).fill("First Platypus Bank");
  await frame.contentFrame().getByText("First Platypus Bank",{ exact:true }).click();
  await frame.contentFrame().getByRole("button",{ name:"First Platypus Bank",exact:true }).click();
  await frame.contentFrame().getByRole("textbox",{ name:"Username",exact:true }).fill("user_transactions_dynamic");
  await frame.contentFrame().getByLabel("Password",{ exact:true }).fill("pass_good");
  await frame.contentFrame().getByRole("button",{ name:"Submit",exact:true }).click();
  await expect(frame.contentFrame().getByRole("button",{ name:"Submit",exact:true })).not.toBeVisible({ timeout:30000 });
  await frame.contentFrame().getByRole("button",{ name:"Continue",exact:true }).click();
  await expect(frame.contentFrame().getByRole("heading",{ name:"Your accounts",exact:true })).not.toBeVisible({ timeout:30000 });
  await frame.contentFrame().getByRole("button",{ name:"Share data",exact:true }).click();
  await expect(frame.contentFrame().getByRole("button",{ name:"Share data",exact:true })).not.toBeVisible({ timeout:30000 });
  await frame.contentFrame().getByRole("button",{ name:"Finish without saving",exact:true }).click();
  await expect(page.getByText("Bank connected. Select accounts below to start importing transactions.",{ exact:true })).toBeVisible({ timeout:30000 });
  const authorized=await banking();
  if (authorized.connections.length!==1 || authorized.connections[0].environment!=="sandbox") throw new Error("Expected exactly one isolated Sandbox connection.");
  await page.getByRole("button",{ name:"Select accounts",exact:true }).click();
  await page.getByRole("dialog").locator("input[type=checkbox]:enabled").first().check();
  await page.getByRole("button",{ name:"Save accounts and start sync",exact:true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(async () => {
    const result=await client.from("transactions").select("id",{ count:"exact",head:true }).eq("owner_id",uid);
    if (result.error || result.count===null) throw new Error("Cannot count isolated Link test transactions.");
    return result.count;
  },{ timeout:150000,intervals:[1000,3000,5000] }).toBeGreaterThan(0);
  const synced=await banking();
  expect(synced.connections[0].last_synced_at).not.toBeNull();
  console.log("Real Sandbox Link authorization, token exchange, account selection and automatic posted transaction ingestion passed against local Supabase.");
} finally { await cleanup(); }
