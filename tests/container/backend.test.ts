import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { openDatabase, migrate } from "../../apps/web/src/server/database";
import { BudgetService } from "../../apps/web/src/server/budget";
import { authOptions, authHandler } from "../../apps/web/src/server/auth";
import { createAccount, resetPassword } from "../../scripts/container/account";
import { BankService, BankError, encryptToken, decryptToken, work } from "../../apps/web/src/server/plaid";
import { importPrepared, prepareDump } from "../../scripts/container/import";
import { parseDump } from "../../scripts/container/dump";
import { reports } from "@balanced/domain";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readDump } from "../../scripts/container/dump";

let db: ReturnType<typeof openDatabase>, a: BudgetService, b: BudgetService;
beforeEach(() => {
  db = openDatabase(":memory:"); migrate(db);
  const aid = randomUUID(), bid = randomUUID();
  db.prepare("INSERT INTO owners VALUES(?,?)").run(aid, "a@example.test");
  db.prepare("INSERT INTO owners VALUES(?,?)").run(bid, "b@example.test");
  a = new BudgetService(db, aid); b = new BudgetService(db, bid);
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-authentication-secret-32-characters");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("APP_ENV", "local");
  vi.stubEnv("PLAID_TOKEN_KEY", "a".repeat(64));
  vi.stubEnv("PLAID_ENABLED", "true");
  vi.stubEnv("PLAID_ENVIRONMENT", "sandbox");
  vi.stubEnv("PLAID_CLIENT_ID", "test-client");
  vi.stubEnv("PLAID_SECRET", "test-secret");
  vi.stubEnv("PLAID_POLL_HOURS", "6");
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); });
function setup() {
  a.mutate({ action: "section_add", month: "2026-10", name: "Living" });
  const sid = a.month("2026-10").sections.find(s => s.name === "Living")!.id;
  a.mutate({ action: "category_add", month: "2026-10", section_id: sid, name: "Food", planned_cents: 15000 });
  return { sid, cid: a.month("2026-10").categories[0].id };
}
describe("SQLite financial invariants and repository parity", () => {
  it("migrates repeatably and initializes fixed Income independently per owner", () => {
    migrate(db); expect(a.month("2026-10").sections).toHaveLength(1);
    expect(b.month("2026-10").sections[0].id).not.toBe(a.month("2026-10").sections[0].id);
    expect(() => a.mutate({ action: "archive_section", id: a.month("2026-10").sections[0].id })).toThrow(/permanent/);
  });
  it("validates mixed-sign splits atomically, net reports, exclusions and overrides", () => {
    const { cid } = setup();
    a.mutate({ action: "manual", description: "Market", merchant: "Market", original_date: "2026-10-31", amount_cents: -10000 });
    const id = a.month("2026-10").transactions[0].id;
    expect(() => a.mutate({ action: "split", id, allocations: [{ category_id: cid, amount_cents: -9999 }] })).toThrow(/sum exactly/);
    expect(a.transaction(id).allocations[0].amount_cents).toBe(-10000);
    a.mutate({ action: "split", id, allocations: [{ category_id: cid, amount_cents: -12000 }, { category_id: null, amount_cents: 2000 }] });
    expect(reports(a.month("2026-10"), "spending", false, true)[0].value).toBe(12000);
    expect(reports(a.month("2026-10"), "income", false, true)[0].value).toBe(2000);
    a.mutate({ action: "exclude", id, excluded: true });
    expect(a.month("2026-10").transactions).toHaveLength(0);
    expect(() => a.mutate({ action: "remove_category", month: "2026-10", id: cid })).toThrow(/Reassign/);
    a.mutate({ action: "exclude", id, excluded: false });
    a.mutate({ action: "date", id, date: "2026-11-01" });
    expect(a.month("2026-10").transactions).toEqual([]);
    expect(reports(a.month("2026-11"), "spending", false, true)[0].name).toBe("Unplanned");
    expect(a.transaction(id).original_date).toBe("2026-10-31");
  });
  it("copies snapshots without rollover or overwrites; renames stay monthly", () => {
    const { cid } = setup();
    a.mutate({ action: "copy", month: "2026-11", from_month: "2026-10" });
    a.mutate({ action: "rename_category", month: "2026-10", id: cid, name: "Groceries" });
    expect(a.month("2026-11").budget_categories[0].name).toBe("Food");
    expect(a.month("2026-11").transactions).toEqual([]);
    expect(() => a.mutate({ action: "copy", month: "2026-11", from_month: "2026-10" })).toThrow(/empty/);
  });
  it("enforces cross-owner reads and writes across mutation surfaces", () => {
    const { cid, sid } = setup();
    const tid = a.put({ description: "Private", merchant: "", original_date: "2026-10-01", amount_cents: -100 });
    expect(b.month("2026-10").categories).toEqual([]);
    expect(() => b.transaction(tid)).toThrow(/not found/);
    expect(() => b.mutate({ action: "exclude", id: tid, excluded: true })).toThrow(/not found/);
    expect(() => b.mutate({ action: "category_attach", month: "2026-10", id: cid })).toThrow(/not found/);
    expect(() => b.mutate({ action: "category_add", month: "2026-10", section_id: sid, name: "Stolen", planned_cents: 0 })).toThrow(/not found/);
    const other = b.put({ description: "Other", merchant: "", original_date: "2026-10-01", amount_cents: -100 });
    expect(() => b.mutate({ action: "split", id: other, allocations: [{ category_id: cid, amount_cents: -100 }] })).toThrow(/not found/);
  });
  it("rejects CSV duplicates with complete rollback and literal search filtering", () => {
    const row = { description: "100% _ market", merchant: "", original_date: "2026-10-01", amount_cents: -150, external_id: "one" };
    a.import("a".repeat(64), [row]);
    expect(a.preview("a".repeat(64), [row]).repeated).toBe(true);
    expect(() => a.import("a".repeat(64), [row])).toThrow(/Duplicate/);
    expect(() => a.import("b".repeat(64), [{ ...row, external_id: "two" }, row])).toThrow();
    expect(a.transactions()).toHaveLength(1);
    expect(a.page("2026-10", { search: "% _", category: null, uncategorized: true, excluded: "include", sort: "date_desc", offset: 0 }).total).toBe(1);
  });
  it("loads demo once into an empty month", () => {
    a.demo("2026-10"); expect(a.month("2026-10").transactions).toHaveLength(7);
    expect(() => a.demo("2026-10")).toThrow(/already/);
  });
  it("preserves persisted accounts and financial rows in a consistent isolated backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "balanced-backup-"));
    a.put({ description: "Backup fixture", merchant: "", original_date: "2026-10-01", amount_cents: -123 });
    const path = join(directory, "backup.sqlite");
    try {
      await db.backup(path);
      const restored = openDatabase(path);
      try {
        expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(restored.pragma("foreign_key_check")).toEqual([]);
        expect(new BudgetService(restored, a.owner).transactions()[0].amount_cents).toBe(-123);
        migrate(restored);
      } finally { restored.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
describe("Better Auth local accounts", () => {
  it("preserves owner UUIDs, disables signup, persists sessions and revokes them on CLI recovery", async () => {
    await (await getMigrations(authOptions(db))).runMigrations();
    const id = randomUUID(), password = "test-password-12345";
    await createAccount(db, { id, name: "Local user", email: "local@example.test", password });
    const instance = betterAuth(authOptions(db));
    const response = await instance.handler(new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ name: "No", email: "no@example.test", password }) }));
    expect(response.ok).toBe(false);
    const csrf = await authHandler(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.invalid" }, body: JSON.stringify({ email: "local@example.test", password }) }), instance);
    expect(csrf.status).toBe(403);
    const login = await instance.api.signInEmail({ body: { email: "local@example.test", password } });
    expect(login.user.id).toBe(id);
    expect(db.prepare('SELECT 1 FROM session WHERE "userId"=?').get(id)).toBeTruthy();
    await resetPassword(db, "local@example.test", "new-test-password-123");
    expect(db.prepare('SELECT 1 FROM session WHERE "userId"=?').get(id)).toBeUndefined();
    await expect(instance.api.signInEmail({ body: { email: "local@example.test", password } })).rejects.toThrow();
    expect((await instance.api.signInEmail({ body: { email: "local@example.test", password: "new-test-password-123" } })).user.id).toBe(id);
  });
});
function bankFixture() {
  const id = randomUUID();
  db.prepare(`INSERT INTO bank_connections(id,owner_id,item_id,token,environment,institution_name,import_start,status,connected_at,due_at)
    VALUES(?,?,?,?,'sandbox','Test Bank','2026-10-01','syncing',?,?)`).run(id, a.owner, randomUUID(), encryptToken("test-access"), new Date().toISOString(), Date.now() - 1);
  db.prepare("INSERT INTO bank_accounts(connection_id,account_id,name,type,selected) VALUES(?,'checking','Checking','depository',1)").run(id);
  return id;
}
const raw = (id: string, pending = false, amount = 12.34) => ({ transaction_id: id, account_id: "checking", pending_transaction_id: null, pending, date: "2026-10-05", amount, iso_currency_code: "USD", name: "Market", merchant_name: "Market" });
const accounts = { accounts: [{ account_id: "checking", name: "Checking", mask: null, type: "depository", subtype: "checking" }] };
describe("outbound-only Plaid", () => {
  it("encrypts tokens and fails on wrong keys/tampering", () => {
    const encrypted = encryptToken("sensitive-token");
    expect(encrypted).not.toContain("sensitive-token");
    expect(decryptToken(encrypted)).toBe("sensitive-token");
    vi.stubEnv("PLAID_TOKEN_KEY", "b".repeat(64));
    expect(() => decryptToken(encrypted)).toThrow();
  });
  it("stages paginated work atomically and waits for explicit historical readiness", async () => {
    const id = bankFixture();
    let page = 0;
    const call = vi.fn(async (path: string) => path === "accounts/get" ? accounts : [
      { added: [raw("first")], modified: [], removed: [], has_more: true, next_cursor: "page-1" },
      { added: [raw("second", true)], modified: [], removed: [], has_more: false, next_cursor: "page-2", transactions_update_status: "INITIAL_UPDATE_COMPLETE" },
      { added: [], modified: [], removed: [], has_more: false, next_cursor: "page-2", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" },
    ][page++]);
    await work(db, call);
    expect(a.transactions()).toHaveLength(0);
    await work(db, call);
    const service = new BankService(db, a.owner, call);
    expect(a.transactions()).toHaveLength(1);
    expect(service.banking().pending_total).toBe(1);
    expect(service.banking().connections[0].historical_complete).toBe(false);
    await service.bank({ action: "sync", id });
    await work(db, call);
    expect(service.banking().connections[0].historical_complete).toBe(true);
    expect(service.banking().connections[0].status).toBe("active");
  });
  it("queues overlaps for explicit review and guards stale transaction revisions", async () => {
    const id = bankFixture(), tid = a.put({ description: "Market", merchant: "Market", original_date: "2026-10-05", amount_cents: -1234 });
    const call = vi.fn(async (path: string) => path === "accounts/get" ? accounts : { added: [raw("overlap")], modified: [], removed: [], has_more: false, next_cursor: "ready", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
    await work(db, call);
    const bank = new BankService(db, a.owner, call), review = bank.banking().reviews[0];
    expect(review.reason).toBe("overlap"); expect(a.transactions()).toHaveLength(1);
    a.mutate({ action: "exclude", id: tid, excluded: true });
    expect(() => bank.resolve(review.id, review.version, "match", tid, undefined, review.candidates[0].revision)).toThrow(/changed/);
    bank.resolve(review.id, review.version, "match", tid, undefined, a.transaction(tid).revision);
    expect(a.transaction(tid).excluded).toBe(true);
    expect(bank.banking().review_total).toBe(0);
    await bank.bank({ action: "disconnect", id });
    expect(bank.connection(id).token).toBeNull();
  });
  it("restarts pagination after provider mutation and excludes active leases", async () => {
    const id = bankFixture();
    db.prepare("UPDATE bank_connections SET lease='busy',lease_until=? WHERE id=?").run(Date.now() + 100000, id);
    expect(await work(db, vi.fn())).toBe(false);
    db.prepare("UPDATE bank_connections SET lease_until=0,page_cursor='partial' WHERE id=?").run(id);
    const call = vi.fn(async (path: string) => { if (path === "accounts/get") return accounts; throw new BankError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"); });
    await work(db, call);
    expect(new BankService(db, a.owner).connection(id).page_cursor).toBeNull();
  });
  it("handles pending-to-posted transitions independently of source ID ordering within a batch", async () => {
    bankFixture();
    const call = async (path: string) => path === "accounts/get" ? accounts : {
      added: [{ ...raw("a-posted"), pending_transaction_id: "z-pending" }, raw("z-pending", true)],
      modified: [], removed: [], has_more: false, next_cursor: "posted-ready", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    };
    await work(db, call);
    expect(a.transactions()).toHaveLength(1);
    expect(new BankService(db, a.owner, call).banking().pending_total).toBe(0);
  });
  it("requires review for changed categorized amounts/removals and restores without losing user edits", async () => {
    const { cid } = setup(), id = bankFixture();
    let response: unknown = { added: [raw("reviewed")], modified: [], removed: [], has_more: false, next_cursor: "one", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" };
    const call = async (path: string) => path === "accounts/get" ? accounts : response;
    await work(db, call);
    const bank = new BankService(db, a.owner, call), tid = a.transactions()[0].id;
    a.mutate({ action: "split", id: tid, allocations: [{ category_id: cid, amount_cents: -1234 }] });
    a.mutate({ action: "date", id: tid, date: "2026-11-02" });
    response = { added: [], modified: [raw("reviewed", false, 15)], removed: [], has_more: false, next_cursor: "two", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" };
    await bank.bank({ action: "sync", id }); await work(db, call);
    let review = bank.banking().reviews[0];
    expect(review.reason).toBe("amount"); expect(a.transaction(tid).amount_cents).toBe(-1234);
    bank.resolve(review.id, review.version, "accept", tid, [{ category_id: cid, amount_cents: -1500 }], a.transaction(tid).revision);
    expect(a.transaction(tid).date_override).toBe("2026-11-02");
    response = { added: [], modified: [], removed: [{ transaction_id: "reviewed" }], has_more: false, next_cursor: "three", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" };
    await bank.bank({ action: "sync", id }); await work(db, call);
    review = bank.banking().reviews[0]; expect(review.reason).toBe("removed");
    bank.resolve(review.id, review.version, "accept", tid, undefined, a.transaction(tid).revision);
    expect(a.month("2026-11").transactions).toHaveLength(0);
    bank.restore(tid, a.transaction(tid).revision);
    expect(a.month("2026-11").transactions[0].allocations[0].category_id).toBe(cid);
  });
});
describe("current-schema COPY import", () => {
  it("dry-runs, reconciles, imports once, and preserves edits on identical reruns", () => {
    const { cid } = setup();
    const tid = a.put({ description: "Imported fixture", merchant: "Market", original_date: "2026-10-01", amount_cents: -1234 });
    a.mutate({ action: "split", id: tid, allocations: [{ category_id: cid, amount_cents: -1500 }, { category_id: null, amount_cents: 266 }] });
    a.mutate({ action: "exclude", id: tid, excluded: true });
    a.mutate({ action: "date", id: tid, date: "2026-11-01" });
    const source: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of ["budget_sections", "categories", "monthly_budgets", "monthly_budget_sections", "monthly_budget_categories", "transactions", "transaction_allocations", "import_batches"]) {
      source[table] = db.prepare(`SELECT * FROM ${table} WHERE owner_id=?`).all(a.owner) as Array<Record<string, unknown>>;
    }
    const target = openDatabase(":memory:"); migrate(target); target.prepare("INSERT INTO owners VALUES(?,?)").run(a.owner, "a@example.test");
    const input = {
      tables: Object.fromEntries(Object.entries(source).map(([table, rows]) => [`public.${table}`, rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : ["archived", "excluded", "provider_removed"].includes(k) ? v ? "t" : "f" : String(v)])))])),
      columns: {},
    };
    try {
      const prepared = prepareDump(input);
      importPrepared(target, prepared, "test-source", true);
      expect(target.prepare("SELECT 1 FROM categories").get()).toBeUndefined();
      importPrepared(target, prepared, "test-source", false);
      expect(new BudgetService(target, a.owner).month("2026-10").budget_categories[0].planned_cents).toBe(15000);
      expect(new BudgetService(target, a.owner).transaction(tid)).toEqual(a.transaction(tid));
      expect(importPrepared(target, prepared, "test-source", false).alreadyImported).toBe(true);
    } finally { target.close(); }
  });
  it("imports legacy history with exact cents and preserves pending outside totals", () => {
    const owner = a.owner, budget = randomUUID(), posted = randomUUID(), pending = randomUUID();
    const legacy = {
      "public.budgets": [{ id: budget, user_id: owner, month: "2026-10-01" }],
      "public.budget_subsections": [], "public.categories": [], "public.budget_category_allocations": [],
      "public.transaction_category_splits": [],
      "public.transactions": [posted, pending].map((id, i) => ({
        id, user_id: owner, source_transaction_id: `source-${i}`, transaction_date: "2026-10-01", transaction_date_override: null,
        merchant_name: "Legacy market", transaction_name: null, amount: "-12.34", currency_code: "USD",
        is_pending: i ? "t" : "f", is_ignored: "f", created_at: "2026-10-01T00:00:00Z",
      })),
      "public.plaid_items": [{ id: randomUUID(), user_id: owner, access_token: "do-not-import", status: "active" }],
    };
    const prepared = prepareDump({ tables: legacy, columns: {} });
    importPrepared(db, prepared, "legacy-test", false);
    expect(a.transactions()).toHaveLength(1);
    expect(a.transaction(posted).amount_cents).toBe(-1234);
    const archived = db.prepare("SELECT value FROM historical_provider_data WHERE table_name='public.plaid_items'").get() as { value: string };
    expect(archived.value).not.toContain("do-not-import");
    expect(prepared.archive.some(a => a.row.id === pending)).toBe(true);
    expect(db.prepare("SELECT 1 FROM bank_connections").get()).toBeUndefined();
  });
  it("reads gzip COPY data and rejects custom archives, malformed rows and inconsistent headers", () => {
    const directory = mkdtempSync(join(tmpdir(), "balanced-dump-"));
    try {
      const path = join(directory, "data.gz");
      writeFileSync(path, gzipSync("COPY public.x (id, value) FROM stdin;\none\t\\\\N\n\\.\n"));
      expect(readDump(path).tables["public.x"][0].value).toBe("\\N");
      writeFileSync(path, "PGDMPfake");
      expect(() => readDump(path)).toThrow(/custom-format/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(() => parseDump("COPY public.x (id,value) FROM stdin;\none\n\\.\n")).toThrow(/expected 2/);
    expect(() => parseDump("COPY public.x (id) FROM stdin;\none\n\\.\nCOPY public.x (other) FROM stdin;\ntwo\n\\.\n")).toThrow(/Inconsistent/);
  });
  it("parses escaped COPY fields, nulls, quoted names and ignores function-body COPY text", () => {
    const dump = parseDump(`CREATE FUNCTION x() RETURNS void AS $$ COPY public.bad (id) FROM stdin; $$ LANGUAGE sql;
COPY "public"."transactions" ("id", "description", "merchant") FROM stdin;
abc\tfirst\\nsecond\\tthird\t\\N
def\tliteral\\\\N\t\\\\
\\.
`);
    expect(dump.tables["public.transactions"][0]).toEqual({ id: "abc", description: "first\nsecond\tthird", merchant: null });
    expect(dump.tables["public.transactions"][1].description).toBe("literal\\N");
    expect(dump.tables["public.bad"]).toBeUndefined();
    expect(() => parseDump("CREATE TABLE x(id text);")).toThrow(/schema-only/);
    expect(() => parseDump("COPY public.x (id) FROM stdin;\na\n")).toThrow(/Truncated/);
    expect(() => parseDump("INSERT INTO public.x VALUES(1);")).toThrow(/--use-copy/);
  });
});
