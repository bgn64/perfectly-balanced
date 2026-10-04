import { configuration, constantEqual } from "./runtime.ts";
const names=["SUPABASE_URL","APP_DEPLOYMENT_ENV","APP_ALLOWED_ORIGINS","PLAID_ENVIRONMENT","PLAID_REDIRECT_URI","PLAID_WEBHOOK_URL"] as const;
Deno.test("configuration fails closed and omits blank optional Sandbox fields", () => {
  const old=names.map(name => Deno.env.get(name));
  try {
    Deno.env.set("SUPABASE_URL","http://kong:8000");
    Deno.env.set("APP_DEPLOYMENT_ENV","local");
    Deno.env.set("APP_ALLOWED_ORIGINS","http://127.0.0.1:5173");
    Deno.env.set("PLAID_ENVIRONMENT","sandbox");
    Deno.env.set("PLAID_REDIRECT_URI","");
    Deno.env.set("PLAID_WEBHOOK_URL","");
    const config=configuration();
    if (config.redirect!==undefined || config.webhook!==undefined) throw new Error("Empty optional provider fields were not omitted.");
    Deno.env.set("PLAID_ENVIRONMENT","production");
    let denied=false;
    try { configuration(); } catch { denied=true; }
    if (!denied) throw new Error("Local Production connection was accepted.");
    Deno.env.set("PLAID_ENVIRONMENT","sandbox");
    Deno.env.set("PLAID_REDIRECT_URI","http://127.0.0.1:5173/connections");
    denied=false;
    try { configuration(); } catch { denied=true; }
    if (!denied) throw new Error("HTTP OAuth redirect was accepted.");
    if (!constantEqual("abc","abc") || constantEqual("abc","ab") || constantEqual("abc","abd")) throw new Error("Worker secret comparison failed.");
  } finally {
    names.forEach((name,i) => { if (old[i]===undefined) Deno.env.delete(name); else Deno.env.set(name,old[i]!); });
  }
});
