import { z } from "zod";
import { admin, failure, json, limitedBody, report, SafeError } from "../_shared/runtime.ts";
import { plaid } from "../_shared/plaid.ts";
import { digest, verifyWebhook } from "../_shared/webhook.ts";
Deno.serve(async request => {
  try {
    if (request.method !== "POST") throw new SafeError("METHOD_NOT_ALLOWED", 405);
    const signature = request.headers.get("plaid-verification");
    if (!signature) throw new SafeError("WEBHOOK_SIGNATURE_REQUIRED", 400);
    const body = await limitedBody(request);
    await verifyWebhook(signature, body, async key_id => z.object({ key: z.object({
      kty: z.literal("EC"), crv: z.literal("P-256"), alg: z.literal("ES256"),
      x: z.string(), y: z.string(), expired_at: z.number().nullable(),
    }) }).parse(await plaid("webhook_verification_key/get", { key_id })).key);
    const event = z.object({ item_id: z.string(), webhook_type: z.string(), webhook_code: z.string(),
      initial_update_complete: z.boolean().optional(), historical_update_complete: z.boolean().optional(),
      error: z.object({ error_code: z.string() }).nullable().optional() }).parse(JSON.parse(body));
    await admin("webhook", { item_id: event.item_id, type: event.webhook_type, code: event.webhook_code,
      error_code: event.error?.error_code ?? null, signature_hash: await digest(signature),
      initial_complete: event.initial_update_complete ?? false, historical_complete: event.historical_update_complete ?? false });
    return json({ received: true });
  } catch (error) { report(error, "Plaid webhook rejected"); return failure(error); }
});
