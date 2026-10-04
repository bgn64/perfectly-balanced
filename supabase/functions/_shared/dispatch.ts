import { z } from "zod";
import { constantEqual, SafeError } from "./runtime.ts";
export async function dispatchSignature(body: string,secret: string) {
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{ name:"HMAC",hash:"SHA-256" },false,["sign"]);
  const signature=await crypto.subtle.sign("HMAC",key,encoder.encode(body));
  return Array.from(new Uint8Array(signature),b => b.toString(16).padStart(2,"0")).join("");
}
export async function verifyDispatch(body: string,signature: string,secret: string,environment: "sandbox" | "production") {
  if (!/^[a-f0-9]{64}$/.test(signature) || !constantEqual(signature,await dispatchSignature(body,secret))) throw new SafeError("WORKER_AUTH_REQUIRED",401);
  const parsed=z.object({ issued_at:z.number().int(),nonce:z.string().uuid(),environment:z.enum(["sandbox","production"]),id:z.string().uuid().optional() })
    .safeParse(JSON.parse(body));
  if (!parsed.success || parsed.data.environment!==environment || Math.abs(Date.now()/1000-parsed.data.issued_at)>60) throw new SafeError("WORKER_SIGNATURE_EXPIRED_OR_INVALID",401);
  return parsed.data;
}
