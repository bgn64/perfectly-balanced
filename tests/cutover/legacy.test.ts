import { describe, expect, it } from "vitest";
import { exactCents, importSql, transformLegacy, verificationSql, type LegacySnapshot } from "../../scripts/cutover/legacy.ts";
import { replacementSql, rollbackSql } from "../../scripts/cutover/replacement.ts";

const uid = "11111111-1111-4111-8111-111111111111";
const bid = "22222222-2222-4222-8222-222222222222";
const sid = "33333333-3333-4333-8333-333333333333";
const food = "44444444-4444-4444-8444-444444444444";
const salary = "55555555-5555-4555-8555-555555555555";
const spare = "66666666-6666-4666-8666-666666666666";
const tid = "77777777-7777-4777-8777-777777777777";
const splitId = "88888888-8888-4888-8888-888888888888";
function fixture(): LegacySnapshot {
  return {
    format: 1, project_ref: "hqeoxulnpkksxvoyxlvq", exported_at: "2026-10-03T17:00:00Z", user_id: uid,
    budgets: [{ id: bid, user_id: uid, month: "2026-09-01" }],
    subsections: [{ id: sid, user_id: uid, budget_id: bid, name: "Living", position: 2 }],
    categories: [
      { id: food, user_id: uid, name: "Food" },
      { id: salary, user_id: uid, name: "Salary" },
      { id: spare, user_id: uid, name: "Unplaced" },
    ],
    budget_allocations: [
      { id: "99999999-9999-4999-8999-999999999999", user_id: uid, budget_id: bid, category_id: food, subsection_id: sid, amount: "-450.00", direction: "spending", position: 0 },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: uid, budget_id: bid, category_id: salary, subsection_id: null, amount: "4200.00", direction: "income", position: 0 },
    ],
    transactions: [{
      id: tid, user_id: uid, source_transaction_id: "provider-1", transaction_date: "2026-08-31",
      transaction_date_override: "2026-09-01", merchant_name: "Market", transaction_name: null,
      amount: "-100.00", currency_code: "USD", is_pending: true, is_ignored: true,
      created_at: "2026-09-01T12:00:00Z", account_name: "Archived account",
    }],
    splits: [{ id: splitId, user_id: uid, transaction_id: tid, category_id: food, amount: "-80.00" }],
    migration_versions: ["20260908210000"],
  };
}

describe("exact legacy migration", () => {
  it("converts decimal dollars without rounding or floating-point arithmetic", () => {
    expect(exactCents("-42.500000")).toBe(-4250);
    expect(exactCents("0.0100")).toBe(1);
    expect(exactCents("1000000000.00")).toBe(100_000_000_000);
    expect(() => exactCents("1.001")).toThrow();
    expect(() => exactCents("1000000000.01")).toThrow();
  });

  describe("allowlisted replacement and rollback", () => {
    const migrations = [{ filename: "20261002000100_budget.sql", sql: "create schema app_private;" }];

    it("requires disconnected providers, the known owner and ledger, and rejects unexpected objects", () => {
      const source = fixture();
      const sql = replacementSql(transformLegacy(source), source.migration_versions, migrations);
      expect(sql).toContain("Plaid must be disconnected and quiescent");
      expect(sql).toContain("Unexpected legacy migration history");
      expect(sql).toContain("Unexpected auth user identity");
      expect(sql).toContain("Unexpected public function");
      expect(sql).toContain("Unexpected public relation");
      expect(sql).toContain("lock table public.transaction_category_splits");
      expect(sql).toContain("insert into supabase_migrations.schema_migrations");
      expect(sql.match(/\nbegin;\n/g)).toHaveLength(1);
      expect(sql.match(/\ncommit;\n/g)).toHaveLength(1);
      expect(sql).not.toContain("drop schema public");
      expect(sql).not.toContain("drop schema auth");
      expect(sql).not.toContain("cascade");
      expect(sql).not.toContain("drop function public.rls_auto_enable");
    });

    it("rejects malformed or missing migration inventories", () => {
      const plan = transformLegacy(fixture());
      expect(() => replacementSql(plan, [], migrations)).toThrow();
      expect(() => replacementSql(plan, ["invalid"], migrations)).toThrow();
      expect(() => replacementSql(plan, ["20260908210000"], [])).toThrow();
      expect(() => replacementSql(plan, ["20260908210000"], [{ filename: "../bad.sql", sql: "" }])).toThrow();
    });

    it("restores the ledger table definition and keeps revoked connections disconnected", () => {
      const plan = transformLegacy(fixture());
      const sql = rollbackSql(plan, 'CREATE TABLE IF NOT EXISTS "public"."transactions"', 'COPY "public"."transactions"');
      expect(sql).toContain("drop table supabase_migrations.schema_migrations;");
      expect(sql).not.toContain("truncate table supabase_migrations.schema_migrations;");
      expect(sql).toContain("status='disconnected',vault_secret_id=null");
      expect(sql).toContain("drop schema app_private;");
      expect(sql).not.toContain("drop schema public");
      expect(sql).not.toContain("cascade");
      expect(() => rollbackSql(plan, "", "")).toThrow();
    });
  });

  it("preserves IDs, user categorization, signs, dates, exclusions, and source identity", () => {
    const plan = transformLegacy(fixture());
    expect(plan.tables.transactions).toEqual([{
      id: tid, owner_id: uid, description: "Market", merchant: "Market", amount_cents: -10000,
      currency: "USD", original_date: "2026-08-31", date_override: "2026-09-01",
      excluded: true, source: "plaid", source_id: "provider-1", created_at: "2026-09-01T12:00:00Z",
    }]);
    expect(plan.tables.transaction_allocations[0]).toMatchObject({ id: splitId, category_id: food, amount_cents: -8000 });
    expect(plan.tables.transaction_allocations[1]).toMatchObject({ category_id: null, amount_cents: -2000 });
    expect(plan.summary).toMatchObject({
      legacy_splits: 1, uncategorized_allocations: 1, pending_imported_as_ordinary: 1,
      exclusions: 1, date_overrides: 1, transaction_cents: -10000, assigned_cents: -8000,
      uncategorized_cents: -2000, planned_cents: 465000, unplaced_categories: 1,
    });
  });

  it("maps Income, spending subsections, and unplaced General categories without inventing budgets", () => {
    const plan = transformLegacy(fixture());
    const sections = plan.tables.budget_sections;
    expect(sections.find(s => s.kind === "income")).toMatchObject({ name: "Income", position: 0, archived: false });
    expect(plan.tables.categories.find(c => c.id === food)?.section_id).toBe(sections.find(s => s.name === "Living")?.id);
    expect(plan.tables.categories.find(c => c.id === spare)?.section_id).toBe(sections.find(s => s.name === "General")?.id);
    expect(plan.tables.monthly_budget_categories.find(c => c.category_id === food)?.planned_cents).toBe(45000);
    expect(plan.tables.monthly_budget_categories.some(c => c.category_id === spare)).toBe(false);
    expect(plan.tables.monthly_budget_sections.map(s => s.name)).toEqual(["Income", "Living"]);
  });

  it("maps root spending to General and keeps empty subsection snapshots", () => {
    const source = fixture();
    source.budget_allocations[0].subsection_id = null;
    const plan = transformLegacy(source);
    const general = plan.tables.budget_sections.find(s => s.name === "General")!;
    expect(plan.tables.categories.find(c => c.id === food)?.section_id).toBe(general.id);
    expect(plan.tables.monthly_budget_sections.map(s => s.name)).toEqual(["Income", "General", "Living"]);
  });

  it("supports exact mixed-sign splits and transactions with no assignments", () => {
    const source = fixture();
    source.splits[0].amount = "-120.00";
    const plan = transformLegacy(source);
    expect(plan.tables.transaction_allocations.map(a => a.amount_cents)).toEqual([-12000, 2000]);
    source.splits = [];
    expect(transformLegacy(source).tables.transaction_allocations).toHaveLength(1);
  });

  it("is deterministic and changes the fingerprint if the source changes", () => {
    const source = fixture();
    expect(transformLegacy(source)).toEqual(transformLegacy(structuredClone(source)));
    const original = transformLegacy(source).source_hash;
    source.transactions[0].is_ignored = false;
    expect(transformLegacy(source).source_hash).not.toBe(original);
  });

  it("rejects conflicting historical section or direction changes", () => {
    const source = fixture();
    const next = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    source.budgets.push({ id: next, user_id: uid, month: "2026-10-01" });
    source.budget_allocations.push({
      ...source.budget_allocations[0], id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      budget_id: next, subsection_id: null,
    });
    expect(() => transformLegacy(source)).toThrow(/changes section/);
    source.budget_allocations[2].direction = "income";
    source.budget_allocations[2].amount = "450";
    expect(() => transformLegacy(source)).toThrow(/changes section/);
  });

  it("rejects cross-owner rows, missing references, duplicate IDs, and unsupported records", () => {
    const cases: Array<(source: LegacySnapshot) => void> = [
      s => { s.categories[0].user_id = bid; },
      s => { s.splits[0].category_id = bid; },
      s => { s.budget_allocations[0].budget_id = food; },
      s => { s.categories.push({ ...s.categories[0] }); },
      s => { s.transactions[0].amount = "0"; },
      s => { s.splits[0].amount = "0"; },
      s => { s.transactions[0].merchant_name = null; },
      s => { s.transactions[0].amount = "-1.001"; },
    ];
    for (const mutate of cases) {
      const source = fixture();
      mutate(source);
      expect(() => transformLegacy(source)).toThrow();
    }
    expect(() => transformLegacy({ ...fixture(), project_ref: "wrong" })).toThrow();
    const unsupported = fixture();
    expect(() => transformLegacy({ ...unsupported, transactions: [{ ...unsupported.transactions[0], currency_code: "EUR" }] })).toThrow();
  });

  it("produces an atomic, owner-guarded, rerun-protected SQL import with escaped text", () => {
    const source = fixture();
    source.transactions[0].merchant_name = "Li'l Market\\shop";
    const sql = importSql(transformLegacy(source));
    expect(sql).toContain("begin;");
    expect(sql).toContain("set local standard_conforming_strings = on;");
    expect(sql).toContain("Li''l Market\\shop");
    expect(sql).toContain("Expected legacy auth user is missing");
    expect(sql).toContain("Cutover requires an empty destination");
    expect(sql).toContain("legacy-cutover:");
    expect(sql).toContain("set constraints all immediate;\ncommit;");
    expect(sql).not.toContain("disable trigger");
    expect(sql).not.toContain("drop ");
  });

  it("verifies every table even when the expected snapshot has no rows", () => {
    const source = fixture();
    source.budgets = []; source.subsections = []; source.budget_allocations = [];
    source.transactions = []; source.splits = [];
    const sql = verificationSql(transformLegacy(source));
    expect(sql).toContain(`from public.transactions where owner_id='${uid}'`);
    expect(sql).toContain(`from public.monthly_budget_categories where owner_id='${uid}'`);
    expect(sql).toContain("fingerprints");
  });
});
