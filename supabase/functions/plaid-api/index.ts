import { z } from "zod";
import { bankRequestSchema } from "../../../packages/domain/src/plaid.ts";
import { admin, authenticate, configuration, failure, json, limitedBody, report, SafeError, service } from "../_shared/runtime.ts";
import { accountsResponse, connectionToken, plaid } from "../_shared/plaid.ts";

Deno.serve(async request => {
  let headers: Record<string, string> = {};
  try {
    const config = configuration();
    const origin = request.headers.get("origin");
    if (!origin || !config.origins.includes(origin)) throw new SafeError("ORIGIN_DENIED", 403);
    headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") throw new SafeError("METHOD_NOT_ALLOWED", 405);
    const owner_id = await authenticate(request);
    const limited = await service().rpc("plaid_rate", { p_owner: owner_id });
    if (limited.error) throw new SafeError("RATE_LIMITED", 429);
    const parsed = bankRequestSchema.safeParse(JSON.parse(await limitedBody(request)));
    if (!parsed.success) throw new SafeError("INVALID_REQUEST", 400);
    const body = parsed.data;
    if (body.action === "link" || body.action === "repair") {
      const intent = body.action === "link" ? z.string().uuid().parse(await admin("intent", { owner_id, import_start: body.import_start })) : null;
      const access_token = body.action === "repair" ? await connectionToken(body.id, owner_id) : undefined;
      const response = z.object({ link_token: z.string() }).parse(await plaid("link/token/create", {
        client_name: "Perfectly Balanced", country_codes: ["US"], language: "en",
        user: { client_user_id: owner_id }, redirect_uri: config.redirect, webhook: config.webhook,
        ...(access_token ? { access_token } : { products: ["transactions"], transactions: { days_requested: 730 } }),
      }));
      return json({ link_token: response.link_token, intent_id: intent, environment: config.environment }, 200, headers);
    }
    if (body.action === "exchange") {
      const claim = z.object({ complete: z.boolean(), id: z.string().uuid().optional() })
        .parse(await admin("exchange_claim", { owner_id, intent_id: body.intent_id }));
      if (claim.complete) return json({ id: claim.id }, 200, headers);
      let accessToken: string | undefined;
      let itemId: string | undefined;
      let persisted = false;
      try {
        const exchange = z.object({ access_token: z.string(), item_id: z.string() })
          .parse(await plaid("item/public_token/exchange", { public_token: body.public_token }));
        accessToken = exchange.access_token;
        itemId = exchange.item_id;
        const item = z.object({ item: z.object({ institution_id: z.string().nullable() }) })
          .parse(await plaid("item/get", { access_token: accessToken }));
        const accounts = accountsResponse.parse(await plaid("accounts/get", { access_token: accessToken }));
        const institution = item.item.institution_id ? z.object({ institution: z.object({ name: z.string() }) })
          .parse(await plaid("institutions/get_by_id", { institution_id: item.item.institution_id, country_codes: ["US"] })).institution.name : "Connected bank";
        const id = z.string().uuid().parse(await admin("create", { owner_id, intent_id: body.intent_id,
          item_id: exchange.item_id, access_token: accessToken, environment: config.environment,
          institution_name: institution, accounts: accounts.accounts }));
        persisted = true;
        return json({ id }, 200, headers);
      } catch (error) {
        if (itemId && !persisted) {
          const stored = await admin("find_item", { owner_id, item_id: itemId });
          if (stored) {
            return json({ id: z.string().uuid().parse(stored) }, 200, headers);
          }
        }
        if (accessToken && !persisted) {
          try { await plaid("item/remove", { access_token: accessToken }); }
          catch (cleanup) { report(cleanup, "Orphan Plaid Item cleanup failed; operator action required"); throw new SafeError("ITEM_CLEANUP_REQUIRED", 500); }
        }
        await admin("exchange_failed", { owner_id, intent_id: body.intent_id });
        throw error;
      }
    }
    if (body.action === "disconnect") {
      const start = z.object({ complete: z.boolean(), access_token: z.string().optional(), environment: z.string().optional() })
        .parse(await admin("disconnect_start", { owner_id, id: body.id }));
      if (start.complete) return json({ disconnected: true }, 200, headers);
      try {
        if (start.environment !== config.environment || !start.access_token) throw new SafeError("UNSAFE_ENVIRONMENT");
        try { await plaid("item/remove", { access_token: start.access_token }); }
        catch (error) { if (!(error instanceof SafeError && error.code === "INVALID_ACCESS_TOKEN")) throw error; }
        await admin("disconnect_finish", { owner_id, id: body.id });
      } catch (error) { await admin("disconnect_failed", { owner_id, id: body.id }); throw error; }
      return json({ disconnected: true }, 200, headers);
    }
    if (body.action === "accounts") {
      const access_token = await connectionToken(body.id, owner_id);
      const snapshot = accountsResponse.parse(await plaid("accounts/get", { access_token }));
      const allowed = new Set(snapshot.accounts.filter(a => ["depository", "credit"].includes(a.type)).map(a => a.account_id));
      if (body.accounts.some(id => !allowed.has(id))) throw new SafeError("ACCOUNT_SELECTION_INVALID", 400);
      await admin("accounts_snapshot", { owner_id, id: body.id, accounts: snapshot.accounts });
      await admin("accounts", { owner_id, id: body.id, accounts: body.accounts });
    } else if (body.action === "repaired") {
      const access_token = await connectionToken(body.id, owner_id);
      const item = z.object({ item: z.object({ error: z.unknown().nullable() }) }).parse(await plaid("item/get", { access_token }));
      if (item.item.error) throw new SafeError("ITEM_STILL_NEEDS_REPAIR", 409);
      await admin("repaired", { owner_id, id: body.id });
    } else await admin("request", { owner_id, id: body.id });
    return json({ queued: true }, 200, headers);
  } catch (error) {
    report(error, "Plaid user operation failed");
    return failure(error, headers);
  }
});
