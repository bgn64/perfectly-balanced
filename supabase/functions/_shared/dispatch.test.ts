import { dispatchSignature,verifyDispatch } from "./dispatch.ts";
async function rejects(fn: () => Promise<unknown>) {
  let failed=false;
  try { await fn(); } catch { failed=true; }
  if (!failed) throw new Error("Unauthenticated dispatch was accepted.");
}
Deno.test("worker signatures bind exact body, environment and freshness without exposing the key",async () => {
  const secret="synthetic-signing-key-never-in-a-request";
  const payload={ nonce:crypto.randomUUID(),environment:"sandbox",issued_at:Math.floor(Date.now()/1000) };
  const body=JSON.stringify(payload);
  const signature=await dispatchSignature(body,secret);
  const verified=await verifyDispatch(body,signature,secret,"sandbox");
  if (verified.nonce!==payload.nonce) throw new Error("Dispatch identity lost.");
  await rejects(() => verifyDispatch(body+" ",signature,secret,"sandbox"));
  await rejects(() => verifyDispatch(body,signature,secret,"production"));
  await rejects(() => verifyDispatch(body,"",secret,"sandbox"));
  const expired=JSON.stringify({ ...payload,issued_at:payload.issued_at-61 });
  await rejects(async () => verifyDispatch(expired,await dispatchSignature(expired,secret),secret,"sandbox"));
});
