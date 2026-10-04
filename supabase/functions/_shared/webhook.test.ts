import { generateKeyPair, exportJWK, SignJWT } from "npm:jose@6.2.2";
import { digest, verifyWebhook } from "./webhook.ts";
import { changesForPage } from "./sync.ts";
function assert(value: boolean, message: string) { if (!value) throw new Error(message); }
async function rejects(fn: () => Promise<unknown>) {
  let failed = false;
  try { await fn(); } catch { failed = true; }
  assert(failed, "Expected rejection");
}
Deno.test("webhook signatures bind exact body, algorithm, freshness, and live keys", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const key = { ...await exportJWK(publicKey), alg: "ES256", expired_at: null };
  const body = '{"item_id":"test","webhook_code":"SYNC_UPDATES_AVAILABLE"}';
  const sign = (iat: number) => new SignJWT({ request_body_sha256: awaitDigest }).setProtectedHeader({ alg: "ES256", kid: "key" }).setIssuedAt(iat).sign(privateKey);
  const awaitDigest = await digest(body);
  const signature = await sign(Math.floor(Date.now()/1000));
  await verifyWebhook(signature,body,async () => key);
  await rejects(() => verifyWebhook(signature,body+" ",async () => key));
  await rejects(() => verifyWebhook(signature,body,async () => ({ ...key,expired_at:1 })));
  await rejects(async () => verifyWebhook(await sign(Math.floor(Date.now()/1000)-301),body,async () => key));
  await rejects(() => verifyWebhook("invalid",body,async () => key));
});
Deno.test("pages preserve pending identities and surface invalid records without fabricated amounts", () => {
  const value = { transaction_id:"posted",account_id:"checking",pending_transaction_id:"pending",pending:false,
    date:"2026-10-04",amount:12.34,iso_currency_code:"USD",name:"Market",merchant_name:null };
  const result = changesForPage({ added:[value,{ ...value,transaction_id:"bad",iso_currency_code:"EUR" }],
    modified:[],removed:[{ transaction_id:"pending" }],next_cursor:"cursor",has_more:false });
  assert(result.changes[0].value?.amount_cents===-1234,"Wrong sign");
  assert(result.changes[0].value?.pending_transaction_id==="pending","Lost pending link");
  assert(result.changes[1].error!==null && result.changes[1].value===null,"Invalid row silently accepted");
  assert(result.changes[2].removed,"Removal missing");
  const notReady=changesForPage({ added:[],modified:[],removed:[],next_cursor:"",has_more:false });
  assert(notReady.page.next_cursor==="" && notReady.changes.length===0,"Initial not-ready response was rejected.");
});
