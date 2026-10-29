import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  bankRequestSchema, bankingSchema, normalizePlaidTransaction, providerTransactionSchema, PlaidNormalizationError,
  type BankRequest, type ProviderTransaction, type AllocationInput,
} from "@balanced/domain";
import { BudgetService } from "./budget.ts";
import type Database from "better-sqlite3";

export class BankError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function plaidConfig() {
  if (process.env.PLAID_ENABLED !== "true") throw new BankError("Bank connections are disabled. Ask the administrator to configure Plaid.");
  const environment = z.enum(["sandbox", "production"]).parse(process.env.PLAID_ENVIRONMENT ?? "sandbox");
  if (environment === "production" && process.env.APP_ENV !== "server") throw new Error("Local Plaid is restricted to Sandbox.");
  const clientId = process.env.PLAID_CLIENT_ID, secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) throw new BankError("Bank connections are not configured.");
  const origin = process.env.BETTER_AUTH_URL;
  if (!origin) throw new BankError("Application origin is not configured.");
  const interval = z.coerce.number().int().min(0).max(168).parse(process.env.PLAID_POLL_HOURS ?? "6");
  key();
  return { environment, clientId, secret, origin, interval: interval * 3600000 };
}
function key() {
  const input = process.env.PLAID_TOKEN_KEY;
  if (!input || !/^[a-f0-9]{64}$/i.test(input)) throw new BankError("PLAID_TOKEN_KEY must be a 32-byte hexadecimal key.");
  return Buffer.from(input, "hex");
}
export function encryptToken(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString("base64")).join(".");
}
export function decryptToken(value: string) {
  const parts = value.split(".");
  if (parts.length !== 3) throw new BankError("Encrypted bank token is invalid.");
  const [iv, tag, encrypted] = parts.map(p => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
export async function plaid(path: string, body: Record<string, unknown>, fetcher = fetch): Promise<unknown> {
  const config = plaidConfig();
  const response = await fetcher(`https://${config.environment}.plaid.com/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error_code: z.string().regex(/^[A-Z_]+$/) }).safeParse(payload);
    throw new BankError(parsed.success ? parsed.data.error_code : "PLAID_REQUEST_FAILED");
  }
  return payload;
}
const accountsSchema = z.object({ accounts: z.array(z.object({
  account_id: z.string().min(1), name: z.string().min(1).max(200), mask: z.string().nullable(),
  type: z.string(), subtype: z.string().nullable(),
})) });
const connectionSchema = z.object({
  id: z.string(), owner_id: z.string(), token: z.string().nullable(), environment: z.string(), cursor: z.string().nullable(),
  import_start: z.string(), status: z.string(), lease: z.string().nullable(), lease_until: z.number().nullable(),
  attempts: z.number(), page_cursor: z.string().nullable(),
});
const recordSchema = z.object({
  id: z.string(), connection_id: z.string(), source_id: z.string(), value: z.string().nullable(),
  error: z.string().nullable(), removed: z.number(), transaction_id: z.string().nullable(),
  state: z.string(), version: z.number(), reason: z.string().nullable(), candidates: z.string(),
});
function normalized(value: string | null) { return value ? providerTransactionSchema.parse(JSON.parse(value)) : null; }
function merchant(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
export class BankService extends BudgetService {
  readonly call: typeof plaid;
  constructor(db: Database.Database, owner: string, call = plaid) { super(db, owner); this.call = call; }
  connection(id: string) {
    return connectionSchema.parse(this.one("SELECT * FROM bank_connections WHERE owner_id=? AND id=?", this.owner, id));
  }
  token(id: string) {
    const c = this.connection(id);
    if (c.environment !== plaidConfig().environment || !c.token || ["disconnecting", "disconnected"].includes(c.status)) throw new BankError("Connection unavailable in this environment.");
    return decryptToken(c.token);
  }
  snapshot(id: string, input: unknown, allowMissing = false) {
    const { accounts } = accountsSchema.parse(input);
    for (const a of accounts) this.run(`INSERT INTO bank_accounts(connection_id,account_id,name,mask,type,subtype)
      VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,account_id) DO UPDATE SET name=excluded.name,mask=excluded.mask,type=excluded.type,subtype=excluded.subtype`,
    id, a.account_id, a.name, a.mask, a.type, a.subtype);
    const available = new Set(accounts.map(a => a.account_id));
    const missing = this.rows("SELECT * FROM bank_accounts WHERE connection_id=? AND selected=1", id).filter(a => !available.has(String(a.account_id)));
    if (missing.length && !allowMissing) throw new BankError("SELECTED_ACCOUNT_UNAVAILABLE");
    return accounts;
  }
  async bank(input: BankRequest) {
    const body = bankRequestSchema.parse(input), config = plaidConfig();
    if (body.action === "link" || body.action === "repair") {
      const intent = body.action === "link" ? randomUUID() : null;
      if (body.action === "link") this.run("INSERT INTO bank_intents(id,owner_id,import_start,created_at) VALUES(?,?,?,?)", intent, this.owner, body.import_start, Date.now());
      const redirect = new URL("/connections", config.origin);
      const result = z.object({ link_token: z.string() }).parse(await this.call("link/token/create", {
        client_name: "Perfectly Balanced", country_codes: ["US"], language: "en", user: { client_user_id: this.owner },
        ...(redirect.protocol === "https:" ? { redirect_uri: redirect.href } : {}),
        ...(body.action === "repair" ? { access_token: this.token(body.id) } : { products: ["transactions"], transactions: { days_requested: 730 } }),
      }));
      return { link_token: result.link_token, intent_id: intent, environment: config.environment };
    }
    if (body.action === "exchange") {
      const intent = this.one("SELECT * FROM bank_intents WHERE owner_id=? AND id=?", this.owner, body.intent_id);
      if (intent.connection_id) return { id: intent.connection_id };
      if (Number(intent.created_at) < Date.now() - 1800000) throw new BankError("Authorization expired. Connect again.");
      if (!this.run("UPDATE bank_intents SET exchanging=1 WHERE owner_id=? AND id=? AND exchanging=0", this.owner, body.intent_id).changes) throw new BankError("Exchange already in progress; check the connection list before retrying.");
      let access: string | undefined, persisted = false;
      try {
        const exchanged = z.object({ access_token: z.string(), item_id: z.string() }).parse(await this.call("item/public_token/exchange", { public_token: body.public_token }));
        access = exchanged.access_token;
        const item = z.object({ item: z.object({ institution_id: z.string().nullable() }) }).parse(await this.call("item/get", { access_token: access }));
        const accounts = await this.call("accounts/get", { access_token: access });
        const institution = item.item.institution_id ? z.object({ institution: z.object({ name: z.string() }) }).parse(await this.call("institutions/get_by_id", { institution_id: item.item.institution_id, country_codes: ["US"] })).institution.name : "Connected bank";
        const id = randomUUID(), encrypted = encryptToken(access);
        this.db.transaction(() => {
          this.run(`INSERT INTO bank_connections(id,owner_id,item_id,token,environment,institution_name,import_start,status,connected_at)
            VALUES(?,?,?,?,?,?,?,'select_accounts',?)`, id, this.owner, exchanged.item_id, encrypted, config.environment, institution, String(intent.import_start), new Date().toISOString());
          this.snapshot(id, accounts);
          this.run("UPDATE bank_intents SET connection_id=?,exchanging=0 WHERE owner_id=? AND id=?", id, this.owner, body.intent_id);
        }).immediate();
        persisted = true;
        return { id };
      } catch (error) {
        if (access && !persisted) {
          try { await this.call("item/remove", { access_token: access }); }
          catch { throw new BankError("ITEM_CLEANUP_REQUIRED: contact the administrator before connecting again."); }
        }
        this.run("UPDATE bank_intents SET exchanging=0 WHERE owner_id=? AND id=?", this.owner, body.intent_id);
        throw error;
      }
    }
    if (body.action === "disconnect") {
      const c = this.connection(body.id);
      if (c.status === "disconnected") return { disconnected: true };
      if (c.environment !== config.environment || !c.token) throw new BankError("Connection environment mismatch.");
      this.run("UPDATE bank_connections SET status='disconnecting',lease=NULL,lease_until=NULL,due_at=NULL WHERE id=?", c.id);
      try {
        try { await this.call("item/remove", { access_token: decryptToken(c.token) }); }
        catch (error) { if (!(error instanceof BankError && error.code === "INVALID_ACCESS_TOKEN")) throw error; }
        this.run("UPDATE bank_connections SET token=NULL,status='disconnected',error_code=NULL WHERE id=?", c.id);
      } catch (error) {
        this.run("UPDATE bank_connections SET error_code='DISCONNECT_FAILED' WHERE id=?", c.id);
        throw error;
      }
      return { disconnected: true };
    }
    if (body.action === "accounts") {
      const snapshot = await this.call("accounts/get", { access_token: this.token(body.id) });
      this.db.transaction(() => {
        const accounts = this.snapshot(body.id, snapshot, true);
        if (body.accounts.some(id => !accounts.some(a => a.account_id === id && ["depository", "credit"].includes(a.type)))) throw new BankError("Selected accounts unavailable.");
        const c = this.connection(body.id);
        if (c.lease && (c.lease_until ?? 0) > Date.now()) throw new BankError("Sync in progress. Try again shortly.");
        this.run("UPDATE bank_accounts SET selected=0 WHERE connection_id=?", c.id);
        for (const id of body.accounts) this.run("UPDATE bank_accounts SET selected=1 WHERE connection_id=? AND account_id=?", c.id, id);
        this.run("DELETE FROM bank_staging WHERE connection_id=?", c.id);
        this.run("UPDATE bank_connections SET cursor=NULL,page_cursor=NULL,status='syncing',due_at=?,initial_complete=0,historical_complete=0 WHERE id=?", Date.now(), c.id);
      }).immediate();
    } else if (body.action === "repaired") {
      const c = this.connection(body.id);
      const item = z.object({ item: z.object({ error: z.unknown().nullable() }) }).parse(await this.call("item/get", { access_token: this.token(c.id) }));
      if (item.item.error) throw new BankError("Bank still needs authorization.");
      this.run("UPDATE bank_connections SET status='syncing',due_at=?,error_code=NULL,attempts=0 WHERE id=?", Date.now(), c.id);
    } else {
      const c = this.connection(body.id); this.token(c.id);
      if (c.status === "select_accounts") throw new BankError("Select accounts first.");
      this.run("UPDATE bank_connections SET due_at=?,status='syncing',attempts=0 WHERE id=?", Date.now(), c.id);
    }
    return { queued: true };
  }
  banking(offset = 0) {
    z.number().int().nonnegative().parse(offset);
    const records = this.rows("SELECT * FROM bank_records WHERE owner_id=? AND state='review' ORDER BY id LIMIT 30 OFFSET ?", this.owner, offset).map(r => recordSchema.parse(r));
    const pendingWhere = `FROM bank_records r JOIN bank_connections c ON c.id=r.connection_id
      JOIN bank_accounts a ON a.connection_id=c.id AND a.account_id=json_extract(r.value,'$.account_id')
      WHERE r.owner_id=? AND r.state='pending' AND r.removed=0 AND a.selected=1 AND c.status NOT IN('disconnected','disconnecting')`;
    const pending = this.rows(`SELECT r.value,r.connection_id ${pendingWhere} ORDER BY r.id LIMIT 30 OFFSET ?`, this.owner, offset);
    return bankingSchema.parse({
      connections: this.rows("SELECT * FROM bank_connections WHERE owner_id=? ORDER BY connected_at,id", this.owner).map(c => ({
        ...c, initial_complete: !!c.initial_complete, historical_complete: !!c.historical_complete,
        accounts: this.rows("SELECT * FROM bank_accounts WHERE connection_id=? ORDER BY account_id", String(c.id)).map(a => ({ ...a, selected: !!a.selected })),
      })),
      reviews: records.map(r => ({
        ...r, record: normalized(r.value),
        candidates: z.array(z.string()).parse(JSON.parse(r.candidates)).map(id => this.transaction(id)),
      })),
      pending: pending.map(p => ({ ...normalized(String(p.value)), connection_id: p.connection_id })),
      review_total: this.one("SELECT count(*) AS n FROM bank_records WHERE owner_id=? AND state='review'", this.owner).n,
      pending_total: this.one(`SELECT count(*) AS n ${pendingWhere}`, this.owner).n,
    });
  }
  reconcile(id: string) {
    const r = recordSchema.parse(this.one("SELECT * FROM bank_records WHERE owner_id=? AND id=?", this.owner, id));
    if (r.state === "ignored") return;
    const c = this.connection(r.connection_id), value = normalized(r.value);
    const review = (reason: string, candidates: string[]) => this.run("UPDATE bank_records SET state='review',reason=?,candidates=? WHERE id=?", reason, JSON.stringify(candidates), id);
    if (r.error) { review("invalid", []); return; }
    if (r.removed) {
      if (r.transaction_id && !this.transaction(r.transaction_id).provider_removed &&
        !this.rows("SELECT 1 FROM bank_records WHERE owner_id=? AND transaction_id=? AND id<>? AND removed=0 AND state='accepted'", this.owner, r.transaction_id, id).length) review("removed", [r.transaction_id]);
      else this.run("UPDATE bank_records SET state='ignored',reason=NULL WHERE id=?", id);
      return;
    }
    if (!value) throw new BankError("Normalized record missing.");
    if (!this.rows("SELECT 1 FROM bank_accounts WHERE connection_id=? AND account_id=? AND selected=1", c.id, value.account_id).length) return;
    if (value.pending) { this.run("UPDATE bank_records SET state='pending',reason=NULL WHERE id=?", id); return; }
    let tid = r.transaction_id;
    if (!tid) {
      const previous = this.rows("SELECT transaction_id FROM bank_records WHERE owner_id=? AND connection_id=? AND source_id=? AND transaction_id IS NOT NULL", this.owner, c.id, value.pending_transaction_id ?? "")[0];
      const existing = this.rows("SELECT id FROM transactions WHERE owner_id=? AND source='plaid' AND source_id IN(?,?)", this.owner, r.source_id, value.pending_transaction_id ?? "")[0];
      tid = previous ? String(previous.transaction_id) : existing ? String(existing.id) : null;
      if (tid) this.run("UPDATE bank_records SET transaction_id=? WHERE id=?", tid, id);
    }
    if (tid) {
      const t = this.transaction(tid);
      if (t.provider_removed || (t.amount_cents !== value.amount_cents && (t.allocations.length > 1 || t.allocations.some(a => a.category_id)))) { review("amount", [tid]); return; }
      this.apply(tid, value);
    } else {
      if (value.original_date < c.import_start) { this.run("UPDATE bank_records SET state='before_start',reason=NULL WHERE id=?", id); return; }
      const candidates = this.transactions("AND amount_cents=? AND provider_removed=0 AND abs(julianday(original_date)-julianday(?))<=3", value.amount_cents, value.original_date)
        .filter(t => merchant(t.merchant || t.description) === merchant(value.merchant || value.description));
      if (candidates.length) { review("overlap", candidates.map(t => t.id)); return; }
      tid = this.put(value, "plaid", value.transaction_id);
    }
    this.run("UPDATE bank_records SET transaction_id=?,state='accepted',reason=NULL,candidates='[]' WHERE id=?", tid, id);
    if (value.pending_transaction_id) this.run("UPDATE bank_records SET state='ignored' WHERE connection_id=? AND source_id=? AND state='pending'", c.id, value.pending_transaction_id);
  }
  apply(id: string, value: ProviderTransaction, allocations?: AllocationInput[]) {
    const t = this.transaction(id);
    if (t.amount_cents !== value.amount_cents) {
      if (!allocations && (t.allocations.length > 1 || t.allocations.some(a => a.category_id))) throw new BankError("Updated splits required.");
      const next = allocations ?? [{ category_id: null, amount_cents: value.amount_cents }];
      this.run("UPDATE transactions SET amount_cents=? WHERE owner_id=? AND id=?", value.amount_cents, this.owner, id);
      this.split(id, next);
    }
    this.run("UPDATE transactions SET description=?,merchant=?,original_date=?,provider_removed=0,revision=revision+1 WHERE owner_id=? AND id=?", value.description, value.merchant, value.original_date, this.owner, id);
  }
  resolve(id: string, version: number, decision: string, tid?: string, allocations?: AllocationInput[], revision?: number) {
    this.db.transaction(() => {
      const r = recordSchema.parse(this.one("SELECT * FROM bank_records WHERE owner_id=? AND id=?", this.owner, id));
      if (r.state !== "review" || r.version !== version) throw new BankError("Review changed. Refresh before resolving.");
      let before: unknown = null, after: unknown = null;
      if (decision === "ignore") this.run("UPDATE bank_records SET state='ignored',reason=NULL,version=version+1 WHERE id=?", id);
      else {
        const value = normalized(r.value);
        if (decision === "new") {
          if (r.reason !== "overlap" || !value) throw new BankError("Invalid review decision.");
          tid = this.put(value, "plaid", r.source_id);
        } else {
          tid = r.transaction_id ?? tid;
          if (!tid || !z.array(z.string()).parse(JSON.parse(r.candidates)).includes(tid)) throw new BankError("Review candidate unavailable.");
          const current = this.transaction(tid);
          if (current.revision !== revision) throw new BankError("Transaction changed. Refresh before resolving.");
          before = current;
          if (decision === "accept" && r.reason === "removed") this.run("UPDATE transactions SET provider_removed=1,revision=revision+1 WHERE owner_id=? AND id=?", this.owner, tid);
          else {
            if (!value || !((decision === "match" && r.reason === "overlap") || (decision === "accept" && r.reason === "amount"))) throw new BankError("Invalid review decision.");
            this.apply(tid, value, allocations);
          }
        }
        after = this.transaction(tid);
        this.run("UPDATE bank_records SET transaction_id=?,state='accepted',reason=NULL,candidates='[]',version=version+1 WHERE id=?", tid, id);
      }
      this.run("INSERT INTO bank_audit(id,owner_id,record_id,decision,before_value,after_value,created_at) VALUES(?,?,?,?,?,?,?)", randomUUID(), this.owner, id, decision, JSON.stringify(before), JSON.stringify(after), new Date().toISOString());
    }).immediate();
  }
  restore(id: string, revision: number) {
    this.db.transaction(() => {
      const t = this.transaction(id);
      if (t.revision !== revision || !t.provider_removed) throw new BankError("Transaction changed. Refresh before restoring.");
      this.run("UPDATE transactions SET provider_removed=0,revision=revision+1 WHERE owner_id=? AND id=?", this.owner, id);
      this.run("UPDATE bank_records SET state='ignored',version=version+1 WHERE owner_id=? AND transaction_id=? AND removed=1", this.owner, id);
      this.run("INSERT INTO bank_audit(id,owner_id,decision,before_value,after_value,created_at) VALUES(?,?,?,?,?,?)", randomUUID(), this.owner, "restore", JSON.stringify(t), JSON.stringify(this.transaction(id)), new Date().toISOString());
    }).immediate();
  }
}

export async function work(db: Database.Database, call = plaid, now = Date.now()) {
  const config = plaidConfig();
  const claim = db.transaction(() => {
    const raw = db.prepare(`SELECT * FROM bank_connections WHERE environment=? AND status IN('active','syncing','error')
      AND due_at IS NOT NULL AND due_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY due_at,id LIMIT 1`).get(config.environment, now, now);
    if (!raw) return null;
    const c = connectionSchema.parse(raw), lease = randomUUID();
    db.prepare("UPDATE bank_connections SET lease=?,lease_until=?,status='syncing' WHERE id=?").run(lease, now + 120000, c.id);
    return { ...c, lease };
  }).immediate();
  if (!claim) return false;
  const service = new BankService(db, claim.owner_id, call);
  const guard = () => {
    const current = service.connection(claim.id);
    if (current.lease !== claim.lease || (current.lease_until ?? 0) < Date.now() || current.status !== "syncing") throw new BankError("STALE_SYNC_LEASE");
  };
  try {
    if (!claim.token) throw new BankError("TOKEN_MISSING");
    const access_token = decryptToken(claim.token);
    const accounts = await call("accounts/get", { access_token });
    const page = z.object({
      added: z.array(z.unknown()), modified: z.array(z.unknown()),
      removed: z.array(z.object({ transaction_id: z.string() })),
      next_cursor: z.string().max(256), has_more: z.boolean(),
      transactions_update_status: z.enum(["TRANSACTIONS_UPDATE_STATUS_UNKNOWN", "NOT_READY", "INITIAL_UPDATE_COMPLETE", "HISTORICAL_UPDATE_COMPLETE"]).optional(),
    }).parse(await call("transactions/sync", { access_token, ...(claim.page_cursor ?? claim.cursor ? { cursor: claim.page_cursor ?? claim.cursor } : {}), count: 500 }));
    const cursor = claim.page_cursor ?? claim.cursor;
    if ((!page.next_cursor && (cursor || page.has_more || page.added.length || page.modified.length || page.removed.length)) || (page.has_more && page.next_cursor === cursor)) throw new BankError("INVALID_SYNC_CURSOR");
    const changes: { source_id: string; value: string | null; error: string | null; removed: number }[] = [...page.added, ...page.modified].map(input => {
      const source_id = z.object({ transaction_id: z.string().min(1) }).parse(input).transaction_id;
      try { return { source_id, value: JSON.stringify(normalizePlaidTransaction(input)), error: null, removed: 0 }; }
      catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof PlaidNormalizationError)) throw error;
        return { source_id, value: null, error: error instanceof z.ZodError ? "INVALID_FIELDS" : error.message, removed: 0 };
      }
    });
    changes.push(...page.removed.map(r => ({ source_id: r.transaction_id, value: null, error: null, removed: 1 })));
    db.transaction(() => {
      guard(); service.snapshot(claim.id, accounts);
      for (const r of changes) service.run(`INSERT INTO bank_staging(connection_id,source_id,value,error,removed) VALUES(?,?,?,?,?)
        ON CONFLICT(connection_id,source_id) DO UPDATE SET value=excluded.value,error=excluded.error,removed=excluded.removed`, claim.id, r.source_id, r.value, r.error, r.removed);
      if (page.has_more) {
        service.run("UPDATE bank_connections SET page_cursor=?,lease=NULL,lease_until=NULL,due_at=? WHERE id=?", page.next_cursor, now, claim.id);
        return;
      }
      const reconcileIds: string[] = [];
      for (const staged of service.rows("SELECT * FROM bank_staging WHERE connection_id=? ORDER BY source_id", claim.id)) {
        const old = service.rows("SELECT * FROM bank_records WHERE connection_id=? AND source_id=?", claim.id, String(staged.source_id))[0];
        const changed = !old || old.value !== staged.value || old.error !== staged.error || old.removed !== staged.removed;
        if (!changed) {
          if (old.state === "new") reconcileIds.push(String(old.id));
          continue;
        }
        service.run(`INSERT INTO bank_records(id,owner_id,connection_id,source_id,value,error,removed) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(connection_id,source_id) DO UPDATE SET value=CASE WHEN excluded.removed=1 THEN bank_records.value ELSE excluded.value END,error=excluded.error,removed=excluded.removed,version=version+1`,
        randomUUID(), claim.owner_id, claim.id, String(staged.source_id), staged.value === null ? null : String(staged.value), staged.error === null ? null : String(staged.error), Number(staged.removed));
        const record = service.one("SELECT id FROM bank_records WHERE connection_id=? AND source_id=?", claim.id, String(staged.source_id));
        reconcileIds.push(String(record.id));
      }
      const priority = (id: string) => {
        const row = recordSchema.parse(service.one("SELECT * FROM bank_records WHERE id=? AND owner_id=?", id, claim.owner_id));
        return row.removed ? 2 : normalized(row.value)?.pending ? 0 : 1;
      };
      for (const id of reconcileIds.sort((a, b) => priority(a) - priority(b))) service.reconcile(id);
      service.run("DELETE FROM bank_staging WHERE connection_id=?", claim.id);
      const historical = page.transactions_update_status === "HISTORICAL_UPDATE_COMPLETE";
      const initial = historical || page.transactions_update_status === "INITIAL_UPDATE_COMPLETE";
      const previous = service.one("SELECT historical_complete FROM bank_connections WHERE id=?", claim.id);
      const complete = historical || !!previous.historical_complete;
      service.run(`UPDATE bank_connections SET cursor=?,page_cursor=NULL,lease=NULL,lease_until=NULL,status=?,attempts=0,error_code=NULL,
        last_synced_at=?,initial_complete=max(initial_complete,?),historical_complete=max(historical_complete,?),due_at=? WHERE id=?`,
      page.next_cursor || claim.cursor, complete ? "active" : "syncing", new Date().toISOString(), Number(initial), Number(historical),
      complete ? (config.interval ? now + config.interval : null) : now + 30000, claim.id);
    }).immediate();
    return true;
  } catch (error) {
    const code = error instanceof BankError ? error.code : "SYNC_FAILED";
    console.error("Plaid synchronization failed", code);
    db.transaction(() => {
      const current = service.connection(claim.id);
      if (current.lease !== claim.lease) return;
      if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
        service.run("DELETE FROM bank_staging WHERE connection_id=?", claim.id);
        service.run("UPDATE bank_connections SET page_cursor=NULL WHERE id=?", claim.id);
      }
      service.run("UPDATE bank_connections SET lease=NULL,lease_until=NULL,attempts=attempts+1,error_code=?,status=?,due_at=? WHERE id=?",
        code, code === "ITEM_LOGIN_REQUIRED" ? "needs_reconnect" : "error",
        code === "ITEM_LOGIN_REQUIRED" ? null : now + Math.min(21600000, 30000 * 2 ** Math.min(claim.attempts, 10)), claim.id);
    }).immediate();
    return true;
  }
}
