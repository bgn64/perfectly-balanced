import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { bankingSchema, normalizePlaidTransaction } from "../../packages/domain/src/plaid.ts";
import type { Database } from "../../packages/data/src/database.types.ts";
import type { BankRequest } from "@balanced/domain";

if (process.env.PLAID_ENVIRONMENT!=="sandbox" || process.env.APP_DEPLOYMENT_ENV!=="local") throw new Error("Sandbox smoke requires local Sandbox configuration.");
const credentials=z.object({ PLAID_CLIENT_ID:z.string().min(1),PLAID_SECRET:z.string().min(1),PLAID_WORKER_SECRET:z.string().min(32) }).parse(process.env);
const config=z.object({ API_URL:z.string(),ANON_KEY:z.string(),SERVICE_ROLE_KEY:z.string() })
  .parse(JSON.parse(execFileSync("npx",["supabase","status","-o","json"],{ encoding:"utf8" })));
if (!["127.0.0.1","localhost"].includes(new URL(config.API_URL).hostname)) throw new Error("Only local Supabase is allowed.");
const admin=createClient<Database>(config.API_URL,config.SERVICE_ROLE_KEY,{ auth:{ persistSession:false } });
const email=`sandbox-smoke-${crypto.randomUUID()}@example.test`,password=crypto.randomUUID();
const created=await admin.auth.admin.createUser({ email,password,email_confirm:true });
if (created.error || !created.data.user) throw new Error("Cannot create isolated smoke-test user.");
const uid=created.data.user.id;
const client=createClient<Database>(config.API_URL,config.ANON_KEY);
let id: string | undefined;
let providerAccess: string | undefined;
let replayChecked=false;
async function bank(body: BankRequest) {
  const result=await client.functions.invoke("plaid-api",{ body,headers:{ Origin:"http://127.0.0.1:5173" } });
  if (result.error) {
    if ("context" in result.error && result.error.context instanceof Response) {
      const value=z.object({ error:z.string() }).parse(await result.error.context.json());
      throw new Error(`Local bank API failed (${value.error}).`);
    }
    throw new Error("Local bank API could not be reached.");
  }
  const value: unknown=result.data;
  return value;
}
async function banking() {
  const result=await client.rpc("app_banking",{});
  if (result.error) throw new Error(`Test banking read failed (${result.error.code}).`);
  return bankingSchema.parse(result.data);
}
async function cleanup() {
  if (id) await bank({ action:"disconnect",id });
  else if (providerAccess) await provider("item/remove",{ access_token:providerAccess });
  const result=await admin.auth.admin.deleteUser(uid);
  if (result.error) throw new Error("Sandbox test-user cleanup failed; operator cleanup required.");
}
async function provider(path: string,body: Record<string,unknown>) {
  const response=await fetch(`https://sandbox.plaid.com/${path}`,{ method:"POST",headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ client_id:credentials.PLAID_CLIENT_ID,secret:credentials.PLAID_SECRET,...body }),signal:AbortSignal.timeout(30000) });
  const value:unknown=await response.json();
  if (!response.ok) {
    const code=z.object({ error_code:z.string() }).safeParse(value);
    throw new Error(`Sandbox request failed: ${code.success ? code.data.error_code : "UNKNOWN_PROVIDER_ERROR"}`);
  }
  return value;
}
async function worker() {
  const body=JSON.stringify({ id,environment:"sandbox",issued_at:Math.floor(Date.now()/1000),nonce:crypto.randomUUID() });
  const signature=createHmac("sha256",credentials.PLAID_WORKER_SECRET).update(body).digest("hex");
  const response=await fetch(`${config.API_URL}/functions/v1/plaid-worker`,{ method:"POST",
    headers:{ "Content-Type":"application/json","x-worker-signature":signature },body });
  if (!response.ok) {
    const code=z.object({ error:z.string() }).parse(await response.json());
    throw new Error(`Local worker failed (${code.error}).`);
  }
  if (!replayChecked) {
    const replay=await fetch(`${config.API_URL}/functions/v1/plaid-worker`,{ method:"POST",
      headers:{ "Content-Type":"application/json","x-worker-signature":signature },body });
    const rejected=z.object({ error:z.string() }).parse(await replay.json());
    if (replay.status!==409 || rejected.error!=="WORKER_REPLAY") throw new Error("Worker dispatch replay was not rejected.");
    replayChecked=true;
  }
}
try {
  const sign=await client.auth.signInWithPassword({ email,password });
  if (sign.error) throw new Error("Test sign-in failed.");
  const start=new Date(); start.setUTCDate(start.getUTCDate()-90);
  const link=z.object({ link_token:z.string().min(1),intent_id:z.string().uuid() })
    .parse(await bank({ action:"link",import_start:start.toISOString().slice(0,10) }));
  const publicToken=z.object({ public_token:z.string() }).parse(await provider("sandbox/public_token/create",{
    institution_id:"ins_109508",initial_products:["transactions"],options:{ override_username:"user_transactions_dynamic" },
  }));
  id=z.object({ id:z.string().uuid() }).parse(await bank({ action:"exchange",intent_id:link.intent_id,public_token:publicToken.public_token })).id;
  const data=await banking();
  const connection=data.connections.find(c => c.id===id)!;
  const accounts=connection.accounts.filter(a => ["depository","credit"].includes(a.type)).map(a => a.account_id);
  if (!accounts.length) throw new Error("Sandbox did not return eligible accounts.");
  await bank({ action:"accounts",id,accounts });
  const token=await admin.rpc("plaid_admin",{ p_action:"token",p_payload:{ id,owner_id:uid } });
  if (token.error) throw new Error("Cannot read isolated test connection token.");
  providerAccess=z.object({ access_token:z.string() }).parse(token.data).access_token;
  for (let i=0;i<20;i++) {
    await worker();
    const state=await banking();
    if (state.connections[0].last_synced_at && state.pending_total>0) break;
    await new Promise(resolve => setTimeout(resolve,2000));
    if (i===15) await bank({ action:"sync",id });
  }
  const before=await banking();
  if (!before.connections[0].last_synced_at || before.pending_total===0) throw new Error("No real Sandbox pending/sync result observed.");
  const rows=await client.from("transactions").select("id",{ count:"exact" }).eq("owner_id",uid);
  if (rows.error || !rows.count) throw new Error("Real Sandbox posted transactions were not ingested.");
  await provider("transactions/refresh",{ access_token:providerAccess });
  await new Promise(resolve => setTimeout(resolve,31000));
  const pendingIds=new Set(before.pending.map(p => p.transaction_id));
  const postedTransitions:string[]=[];
  let cursor:string | undefined;
  for (let i=0;i<20;i++) {
    const changes=z.object({ added:z.array(z.unknown()),next_cursor:z.string(),has_more:z.boolean() })
      .parse(await provider("transactions/sync",{ access_token:providerAccess,cursor,count:500 }));
    for (const raw of changes.added) {
      const normalized=z.object({ transaction_id:z.string(),pending_transaction_id:z.string().nullable(),account_id:z.string(),pending:z.boolean() }).parse(raw);
      if (!normalized.pending && normalized.pending_transaction_id && pendingIds.has(normalized.pending_transaction_id) && accounts.includes(normalized.account_id)) {
        try { normalizePlaidTransaction(raw); postedTransitions.push(normalized.transaction_id); }
        catch (error) { if (!(error instanceof Error && ["ZERO_AMOUNT","INVALID_CENT_PRECISION"].includes(error.message))) throw error; }
      }
    }
    if (!changes.has_more) break;
    if (changes.next_cursor===cursor || i===19) throw new Error("Sandbox verification pagination did not terminate.");
    cursor=changes.next_cursor;
  }
  if (!postedTransitions.length) throw new Error("No real pending-to-posted transition with supported money was observed.");
  await bank({ action:"sync",id });
  for (let i=0;i<10;i++) {
    await worker();
    const state=await banking();
    if (state.connections[0].status==="active") break;
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  const after=await banking();
  if (after.connections[0].status!=="active") throw new Error("Sandbox follow-up sync did not complete.");
  const unsupported=after.reviews.filter(r => r.reason==="invalid");
  if (unsupported.some(r => !["ZERO_AMOUNT","INVALID_CENT_PRECISION"].includes(r.error ?? ""))) throw new Error(`Unexpected Sandbox ingestion issues: ${[...new Set(unsupported.map(r => r.error))].join("; ")}`);
  const posted=await client.from("transactions").select("id",{ count:"exact" }).eq("owner_id",uid).in("source_id",postedTransitions);
  if (posted.error || !posted.count) throw new Error("Supported pending-to-posted transactions were not actually ingested.");
  console.log(`Real Sandbox Link token, exchange, ${accounts.length} account selections and ${posted.count} pending-to-posted transitions passed; ${unsupported.length} unsupported-money issues were explicitly held for review.`);
} finally {
  await cleanup();
}
