import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeClient, SupabaseRepository } from "@balanced/data";
import type { Database, Json } from "../../packages/data/src/database.types";
import type { ProviderTransaction } from "@balanced/domain";

const config = z.object({ API_URL: z.string(), ANON_KEY: z.string(), SERVICE_ROLE_KEY: z.string() })
  .parse(JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" })));
const admin = createClient<Database>(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ids: string[] = [];
let repo: SupabaseRepository, other: SupabaseRepository, connection: string, category: string;
const token = `fixture-${crypto.randomUUID()}`;
const account = { account_id: "fixture-checking", name: "Test checking", mask: "0001", type: "depository", subtype: "checking" };
const transaction = (id: string, values: Partial<ProviderTransaction> = {}): ProviderTransaction => ({
  transaction_id: id, account_id: account.account_id, pending_transaction_id: null,
  pending: false, original_date: "2026-10-04", amount_cents: -1234, description: "Test market", merchant: "Test market", ...values,
});
async function operation(action: string, payload: Json) {
  const response = await admin.rpc("plaid_admin", { p_action: action, p_payload: payload });
  if (response.error) throw new Error(response.error.message);
  return response.data;
}
async function claim() {
  const value = z.object({ id: z.string(), lease: z.string(), cursor: z.string().nullable(), access_token: z.string() })
    .parse(await operation("claim", { environment: "sandbox", id: connection }));
  expect(value.id).toBe(connection);
  return value;
}
async function stage(claimed: Awaited<ReturnType<typeof claim>>, rows: ProviderTransaction[], removed: string[] = [], more = false) {
  return operation("stage", { id: claimed.id, lease: claimed.lease, changes: [
    ...rows.map(value => ({ source_id: value.transaction_id, value, removed: false, error: null })),
    ...removed.map(source_id => ({ source_id, value: null, removed: true, error: null })),
  ], next_cursor: `cursor-${crypto.randomUUID()}`, has_more: more });
}
async function webhook(code = "SYNC_UPDATES_AVAILABLE") {
  return operation("webhook", { item_id: `fixture-${ids[0]}`, type: "TRANSACTIONS", code, signature_hash: crypto.randomUUID() });
}
beforeAll(async () => {
  for (let i=0;i<2;i++) {
    const email = `plaid-${crypto.randomUUID()}@example.test`, password = crypto.randomUUID();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? "Cannot create user");
    ids.push(data.user.id);
    const client = makeClient(config.API_URL, config.ANON_KEY);
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw new Error(signed.error.message);
    if (i===0) repo = new SupabaseRepository(client);
    else other = new SupabaseRepository(client);
  }
});
afterAll(async () => {
  for (const id of ids) {
    const result = await admin.auth.admin.deleteUser(id);
    if (result.error) throw new Error(result.error.message);
  }
});
describe("Plaid real local persistence", () => {
  it("encrypts connection tokens and denies client administration/token access", async () => {
    const intent = z.string().parse(await operation("intent", { owner_id: ids[0], import_start: "2026-10-04" }));
    await operation("exchange_claim", { owner_id: ids[0], intent_id: intent });
    connection = z.string().parse(await operation("create", { owner_id: ids[0], intent_id: intent,
      item_id: `fixture-${ids[0]}`, access_token: token, environment: "sandbox", institution_name: "Fixture bank", accounts: [account] }));
    const data = await repo.banking();
    expect(data.connections[0].status).toBe("select_accounts");
    expect(JSON.stringify(data)).not.toContain(token);
    expect((await other.banking()).connections).toEqual([]);
    expect((await repo.client.rpc("plaid_admin", { p_action: "token", p_payload: { id: connection } })).error).not.toBeNull();
    expect((await makeClient(config.API_URL,config.ANON_KEY).rpc("app_banking", {})).error).not.toBeNull();
    await expect(operation("token", { owner_id: ids[1], id: connection })).rejects.toThrow(/not found/);
    await expect(operation("accounts", { owner_id: ids[0], id: connection, accounts: ["alien"] })).rejects.toThrow(/eligible/);
    await operation("accounts", { owner_id: ids[0], id: connection, accounts: [account.account_id] });
  });
  it("keeps pending and partial pages out of totals and reconciles across pages", async () => {
    const waiting=await claim();
    await operation("await_data",{ id:connection,lease:waiting.lease });
    expect((await repo.banking()).connections[0].status).toBe("syncing");
    expect((await repo.banking()).connections[0].last_synced_at).toBeNull();
    await webhook();
    const first = await claim();
    await stage(first, [transaction("pending", { pending: true }), transaction("old", { original_date: "2026-10-03" })], [], true);
    expect((await repo.month("2026-10")).transactions).toEqual([]);
    const second = await claim();
    await stage(second, [transaction("posted", { pending_transaction_id: "pending" })], ["pending"]);
    const data = await repo.month("2026-10");
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].amount_cents).toBe(-1234);
    expect(data.transactions[0].bank_accounts[0].name).toBe(account.name);
    expect((await repo.banking()).pending).toEqual([]);
    expect((await repo.banking()).connections[0].status).toBe("active");
    await expect(stage(first, [transaction("stale")])).rejects.toThrow(/Stale/);
  });
  it("replays idempotently, stages overlap, and preserves accepted identity and edits", async () => {
    const original = (await repo.month("2026-10")).transactions[0];
    await repo.mutate({ action: "section_add", month: "2026-10", name: "Fixture spending" });
    const section = (await repo.month("2026-10")).sections.find(s => s.name==="Fixture spending")!;
    await repo.mutate({ action: "category_add", month: "2026-10", section_id: section.id, name: "Fixture food", planned_cents: 5000 });
    category = (await repo.month("2026-10")).categories[0].id;
    await repo.mutate({ action: "split", id: original.id, allocations: [{ category_id: category, amount_cents: -1234 }] });
    await repo.mutate({ action: "date", id: original.id, date: "2026-10-07" });
    await webhook();
    await stage(await claim(), [transaction("posted"), transaction("new-authorization-id")]);
    const banking = await repo.banking();
    expect(banking.reviews).toHaveLength(1);
    expect(banking.reviews[0].reason).toBe("overlap");
    expect((await repo.month("2026-10")).transactions).toHaveLength(1);
    const review = banking.reviews[0];
    await expect(other.resolveBank(review.id,review.version,"match",original.id)).rejects.toThrow(/unavailable/);
    await repo.resolveBank(review.id,review.version,"match",original.id,undefined,review.candidates[0].revision);
    const matched = (await repo.month("2026-10")).transactions[0];
    expect(matched.id).toBe(original.id);
    expect(matched.date_override).toBe("2026-10-07");
    expect(matched.allocations[0].category_id).toBe(category);
    await expect(repo.resolveBank(review.id,review.version,"match",original.id,undefined,review.candidates[0].revision)).rejects.toThrow(/changed/);
  });
  it("reviews changed categorized amounts and enforces exact allocation sums", async () => {
    await webhook();
    await stage(await claim(), [transaction("posted", { amount_cents: -1400 })]);
    const review = (await repo.banking()).reviews.find(r => r.reason==="amount")!;
    expect((await repo.month("2026-10")).transactions[0].amount_cents).toBe(-1234);
    await expect(repo.resolveBank(review.id,review.version,"accept",review.transaction_id!,[{ category_id:category,amount_cents:-1399 }],review.candidates[0].revision)).rejects.toThrow(/sum exactly/);
    await repo.resolveBank(review.id,review.version,"accept",review.transaction_id!,[{ category_id:category,amount_cents:-1400 }],review.candidates[0].revision);
    const data = (await repo.month("2026-10")).transactions[0];
    expect(data.amount_cents).toBe(-1400);
    expect(data.allocations[0].amount_cents).toBe(-1400);
    expect(data.date_override).toBe("2026-10-07");
  });
  it("links frozen migrated identities before the start date without erasing user edits", async () => {
    await repo.mutate({ action:"manual",description:"Frozen archive",merchant:"Frozen archive",original_date:"2026-10-02",amount_cents:-2222 });
    const archived=(await repo.page("2026-10",{ search:"Frozen archive",uncategorized:false,excluded:"include",category:null,offset:0,sort:"date_desc" })).items[0];
    const migrated=await admin.from("transactions").update({ source:"plaid",source_id:"frozen-provider-id" }).eq("id",archived.id);
    if (migrated.error) throw new Error(migrated.error.message);
    await repo.mutate({ action:"split",id:archived.id,allocations:[{ category_id:category,amount_cents:-2500 },{ category_id:null,amount_cents:278 }] });
    await repo.mutate({ action:"date",id:archived.id,date:"2026-11-01" });
    await repo.mutate({ action:"exclude",id:archived.id,excluded:true });
    await webhook();
    await stage(await claim(),[transaction("frozen-provider-id",{ original_date:"2026-10-02",amount_cents:-2222,description:"Frozen archive",merchant:"Frozen archive" })]);
    const after=(await repo.page("2026-11",{ search:"Frozen archive",uncategorized:false,excluded:"only",category:null,offset:0,sort:"date_desc" })).items[0];
    expect(after.id).toBe(archived.id);
    expect(after.excluded).toBe(true);
    expect(after.date_override).toBe("2026-11-01");
    expect(after.allocations.map(a => a.amount_cents).sort((a,b)=>a-b)).toEqual([-2500,278]);
  });
  it("fences stale review decisions when a user edits the accepted transaction", async () => {
    await webhook();
    await stage(await claim(),[transaction("posted",{ amount_cents:-1600 })]);
    const review=(await repo.banking()).reviews.find(r => r.reason==="amount")!;
    await repo.mutate({ action:"date",id:review.transaction_id!,date:"2026-10-08" });
    await expect(repo.resolveBank(review.id,review.version,"accept",review.transaction_id!,[{ category_id:category,amount_cents:-1600 }],review.candidates[0].revision)).rejects.toThrow(/changed/);
    expect((await repo.month("2026-10")).transactions[0].amount_cents).toBe(-1400);
    await repo.resolveBank(review.id,review.version,"ignore");
  });
  it("rolls back financial rows and cursor together on invalid application", async () => {
    await webhook();
    const before=(await repo.banking()).connections[0].last_synced_at;
    const claimed=await claim();
    await expect(stage(claimed,[transaction("rollback-valid",{ description:"Unique rollback",merchant:"Unique rollback" }),
      transaction("rollback-bad",{ description:"" })])).rejects.toThrow();
    expect((await repo.banking()).connections[0].last_synced_at).toBe(before);
    expect((await repo.month("2026-10")).transactions).toHaveLength(1);
    await operation("failure",{ id:connection,lease:claimed.lease,error_code:"FIXTURE_FAILURE" });
    await webhook();
  });
  it("retains removed posted amounts until review and hides accepted removals consistently", async () => {
    await webhook();
    await stage(await claim(), [], ["posted", "new-authorization-id"]);
    const banking = await repo.banking();
    const review = banking.reviews.find(r => r.reason==="removed")!;
    expect(review).toBeDefined();
    expect((await repo.month("2026-10")).transactions).toHaveLength(1);
    await repo.resolveBank(review.id,review.version,"accept",undefined,undefined,review.candidates[0].revision);
    expect((await repo.month("2026-10")).transactions).toEqual([]);
    const retained = await repo.page("2026-10", { search:"",uncategorized:false,excluded:"only",category:null,offset:0,sort:"date_desc" });
    expect(retained.items[0].provider_removed).toBe(true);
    expect(retained.items[0].allocations[0].category_id).toBe(category);
    await repo.restoreBankTransaction(retained.items[0].id,retained.items[0].revision);
    expect((await repo.month("2026-10")).transactions).toHaveLength(1);
  });
  it("persists malformed ingestion as visible issues, and disconnect fences workers", async () => {
    await webhook();
    const claimed = await claim();
    await operation("accounts_snapshot",{ id:connection,lease:claimed.lease,accounts:[account,{ account_id:"fixture-loan",name:"Unselected loan",mask:null,type:"loan",subtype:"student" }] });
    await operation("stage", { id: connection,lease:claimed.lease,changes:[
      { source_id:"bad",value:null,error:"Unsupported currency",removed:false },
      { source_id:"loan-precision",account_id:"fixture-loan",value:null,error:"INVALID_CENT_PRECISION",removed:false },
    ],next_cursor:"after-bad",has_more:false });
    expect((await repo.banking()).reviews.some(r => r.reason==="invalid")).toBe(true);
    expect((await repo.banking()).reviews.some(r => r.error==="INVALID_CENT_PRECISION")).toBe(false);
    await webhook();
    const running = await claim();
    await operation("disconnect_start", { owner_id:ids[0],id:connection });
    await expect(stage(running,[transaction("late")])).rejects.toThrow(/Stale/);
    await operation("disconnect_finish", { owner_id:ids[0],id:connection });
    expect((await repo.banking()).connections[0].status).toBe("disconnected");
    await expect(operation("token", { owner_id:ids[0],id:connection })).rejects.toThrow(/disconnected/);
    expect((await repo.page("2026-10",{ search:"",uncategorized:false,excluded:"include",category:null,offset:0,sort:"date_desc" })).total).toBe(1);
  });
});
