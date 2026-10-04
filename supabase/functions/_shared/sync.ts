import { z } from "zod";
import { normalizePlaidTransaction, PlaidNormalizationError } from "../../../packages/domain/src/plaid.ts";
import { admin, configuration, report, SafeError } from "./runtime.ts";
import { accountsResponse, plaid } from "./plaid.ts";

export const syncResponse = z.object({
  added: z.array(z.unknown()), modified: z.array(z.unknown()),
  removed: z.array(z.object({ transaction_id: z.string().min(1) })),
  next_cursor: z.string().max(256), has_more: z.boolean(),
});
export function changesForPage(input: unknown) {
  const page = syncResponse.parse(input);
  const changes = [...page.added, ...page.modified].map(value => {
    const id = z.object({ transaction_id: z.string().min(1) }).parse(value).transaction_id;
    const metadata = z.object({ account_id:z.string().min(1) }).safeParse(value);
    const account_id = metadata.success ? metadata.data.account_id : null;
    try { return { source_id: id, account_id, value: normalizePlaidTransaction(value), error: null, removed: false }; }
    catch (error) {
      if (error instanceof PlaidNormalizationError) return { source_id:id,account_id,value:null,error:error.code,removed:false };
      if (error instanceof z.ZodError) return { source_id:id,account_id,value:null,error:`INVALID_FIELDS: ${[...new Set(error.issues.map(i => i.path.join(".")))].join(", ")}`,removed:false };
      throw error;
    }
  });
  return { page, changes: [...changes, ...page.removed.map(value => ({ source_id: value.transaction_id, account_id:null, value: null, error: null, removed: true }))] };
}
export async function workPage(id?: string) {
  const config = configuration();
  const value = await admin("claim", { environment: config.environment, ...(id ? { id } : {}) });
  if (!value) return false;
  const claim = z.object({ id: z.string().uuid(), lease: z.string().uuid(), cursor: z.string().nullable(), access_token: z.string() }).parse(value);
  try {
    const accounts = accountsResponse.parse(await plaid("accounts/get", { access_token: claim.access_token }));
    const { page, changes } = changesForPage(await plaid("transactions/sync", {
      access_token: claim.access_token, ...(claim.cursor ? { cursor: claim.cursor } : {}), count: 500,
    }));
    if (!page.next_cursor) {
      if (claim.cursor || page.has_more || changes.length) throw new SafeError("INVALID_SYNC_CURSOR");
      await admin("await_data", { id:claim.id,lease:claim.lease });
      return true;
    }
    if (page.has_more && page.next_cursor===claim.cursor) throw new SafeError("INVALID_PAGINATION_CURSOR");
    await admin("accounts_snapshot", { id: claim.id, lease: claim.lease, accounts: accounts.accounts });
    await admin("stage", { id: claim.id, lease: claim.lease, changes, next_cursor: page.next_cursor, has_more: page.has_more });
    return true;
  } catch (error) {
    report(error, "Plaid synchronization failed");
    const code = error instanceof SafeError ? error.code : "SYNC_FAILED";
    await admin(code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" ? "restart" : "failure",
      { id: claim.id, lease: claim.lease, error_code: code });
    throw new SafeError(code);
  }
}
