import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "npm:jose@6.2.2";
import { constantEqual, SafeError } from "./runtime.ts";
export async function digest(body: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), b => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyWebhook(signature: string, body: string, getKey: (id: string) => Promise<JWK & { expired_at?: number | null }>) {
  const header = decodeProtectedHeader(signature);
  if (header.alg !== "ES256" || typeof header.kid !== "string") throw new SafeError("WEBHOOK_SIGNATURE_INVALID", 400);
  const jwk = await getKey(header.kid);
  if (jwk.expired_at != null || jwk.alg !== "ES256") throw new SafeError("WEBHOOK_KEY_INVALID", 400);
  const { payload } = await jwtVerify(signature, await importJWK(jwk, "ES256"), { algorithms: ["ES256"] });
  if (typeof payload.iat !== "number" || Math.abs(Date.now() / 1000 - payload.iat) > 300 ||
    typeof payload.request_body_sha256 !== "string" || !constantEqual(await digest(body), payload.request_body_sha256)) {
    throw new SafeError("WEBHOOK_SIGNATURE_INVALID", 400);
  }
}
