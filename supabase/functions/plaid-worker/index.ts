import { configuration, failure, json, limitedBody, report, required, SafeError, service } from "../_shared/runtime.ts";
import { workPage } from "../_shared/sync.ts";
import { verifyDispatch } from "../_shared/dispatch.ts";
Deno.serve(async request => {
  try {
    if (request.method !== "POST") throw new SafeError("METHOD_NOT_ALLOWED", 405);
    const body=await verifyDispatch(await limitedBody(request),request.headers.get("x-worker-signature") ?? "",
      required("PLAID_WORKER_SECRET"),configuration().environment);
    const receipt=await service().rpc("plaid_worker_receipt",{ p_nonce:body.nonce });
    if (receipt.error) throw new SafeError("WORKER_RECEIPT_FAILED",503);
    if (!receipt.data) throw new SafeError("WORKER_REPLAY",409);
    const worked = await workPage(body.id);
    return json({ worked });
  } catch (error) { report(error, "Plaid worker failed"); return failure(error); }
});
