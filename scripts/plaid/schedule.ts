import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "../../packages/data/src/database.types.ts";
const local = process.argv.includes("--local");
const secret = process.env.PLAID_WORKER_SECRET;
if (!secret || secret.length<32) throw new Error("Configure a PLAID_WORKER_SECRET of at least 32 characters.");
let url: string, key: string;
if (local) {
  const config = z.object({ API_URL:z.string(),SERVICE_ROLE_KEY:z.string() })
    .parse(JSON.parse(execFileSync("npx",["supabase","status","-o","json"],{ encoding:"utf8" })));
  url=config.API_URL; key=config.SERVICE_ROLE_KEY;
  if (!["127.0.0.1","localhost"].includes(new URL(url).hostname) || process.env.PLAID_ENVIRONMENT!=="sandbox") throw new Error("Local scheduling requires local Supabase and Sandbox.");
} else {
  url=process.env.SUPABASE_URL ?? ""; key=process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (url!=="https://hqeoxulnpkksxvoyxlvq.supabase.co" || process.env.PLAID_ENVIRONMENT!=="production") throw new Error("Production scheduling requires the approved project and Production environment.");
}
const client=createClient<Database>(url,key,{ auth:{ persistSession:false } });
const result=await client.rpc("plaid_schedule",{
  p_url:local ? "http://kong:8000/functions/v1/plaid-worker" : `${url}/functions/v1/plaid-worker`,
  p_worker_secret:secret,
});
if (result.error) throw new Error(`Scheduler configuration failed (${result.error.code}).`);
console.log("Plaid worker scheduled. Check connection status and backend worker logs for delivery failures.");
