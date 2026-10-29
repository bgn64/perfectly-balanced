import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { dateSchema, sum, validateSplit } from "../../packages/domain/src/index.ts";
import { transformLegacy, tableNames, type SqlRow } from "../cutover/legacy.ts";
import { readDump, type Dump, type DumpRow } from "./dump.ts";
import { openDatabase } from "../../apps/web/src/server/database.ts";
import { BudgetService } from "../../apps/web/src/server/budget.ts";

const tables = [...tableNames, "import_batches"] as const;
const booleans = new Set(["archived", "excluded", "provider_removed", "is_pending", "is_ignored"]);
const numbers = new Set(["position", "planned_cents", "amount_cents", "revision"]);
function typed(row: DumpRow): SqlRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null) return [key, null];
    if (booleans.has(key)) {
      if (!["t", "f", "true", "false"].includes(value)) throw new Error(`Invalid boolean field ${key}.`);
      return [key, value === "t" || value === "true"];
    }
    if (numbers.has(key)) {
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid exact integer field ${key}.`);
      return [key, Number(value)];
    }
    return [key, value];
  }));
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const legacyNames = ["budgets", "budget_subsections", "categories", "budget_category_allocations", "transactions", "transaction_category_splits"];
const legacyProvider = ["public.plaid_items", "public.plaid_webhook_events"];
function archiveRow(row: DumpRow): DumpRow {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/(token|secret|cursor|lease|signature|dispatch|worker|password)/i.test(key) &&
      !["due_at", "requested_at", "claimed_at", "sync_started_at", "exchanging"].includes(key)).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const cleaned = z.record(z.string(), z.string().nullable()).parse(redact(row));
  return Object.fromEntries(Object.entries(cleaned).map(([key, value]) => {
    if (value && /^[{[]/.test(value)) {
      try { return [key, JSON.stringify(redact(JSON.parse(value)))]; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    return [key, value];
  }));
}
export function prepareDump(dump: Dump) {
  const legacy = !!dump.tables["public.budgets"], current = !!dump.tables["public.monthly_budgets"];
  if (legacy === current) throw new Error("Unrecognized or ambiguous financial schema. Supply the complete application COPY data backup.");
  const owners = new Set<string>();
  const output: Record<string, SqlRow[]> = Object.fromEntries(tables.map(t => [t, []]));
  const archive: { table: string; row: DumpRow }[] = [];
  const permitted = new Set([...(legacy ? legacyNames : [...tables]).map(t => `public.${t}`), ...(legacy ? legacyProvider : [])]);
  for (const [table, rows] of Object.entries(dump.tables)) {
    if (table.startsWith("public.") && !permitted.has(table) && rows.length) throw new Error(`Unsupported nonempty application table ${table}. Explicit mapping is required.`);
  }
  if (legacy) {
    for (const table of legacyNames) if (!dump.tables[`public.${table}`]) throw new Error(`Missing financial table ${table}.`);
    for (const table of legacyNames) for (const r of dump.tables[`public.${table}`]) owners.add(z.string().uuid().parse(r.user_id));
    for (const owner of owners) {
      const get = (table: string) => dump.tables[`public.${table}`].filter(r => r.user_id === owner).map(typed);
      const transactions = get("transactions");
      const pending = new Set(transactions.filter(t => t.is_pending).map(t => t.id));
      const plan = transformLegacy({
        format: 1, project_ref: "hqeoxulnpkksxvoyxlvq", exported_at: new Date().toISOString(), user_id: owner,
        budgets: get("budgets"), subsections: get("budget_subsections"), categories: get("categories"),
        budget_allocations: get("budget_category_allocations"), transactions: transactions.filter(t => !pending.has(t.id)),
        splits: get("transaction_category_splits").filter(s => !pending.has(s.transaction_id)),
        migration_versions: [],
      });
      for (const t of tableNames) output[t].push(...plan.tables[t]);
      for (const t of legacyNames) for (const row of dump.tables[`public.${t}`].filter(r => r.user_id === owner)) archive.push({ table: `legacy.${t}`, row: archiveRow(row) });
    }
  } else {
    for (const table of tables) {
      if (!dump.tables[`public.${table}`]) throw new Error(`Missing financial table ${table}.`);
      output[table] = dump.tables[`public.${table}`].map(typed);
      for (const row of output[table]) owners.add(z.string().uuid().parse(row.owner_id));
    }
  }
  const providerTables = new Set(["plaid_connections", "plaid_accounts", "plaid_records", "plaid_record_accounts", "plaid_staging", "plaid_intents", "plaid_deliveries", "plaid_audit", "plaid_requests", "plaid_worker_receipts"]);
  for (const [table, rows] of Object.entries(dump.tables)) {
    if ((!table.startsWith("app_private.") && !legacyProvider.includes(table)) || !rows.length) continue;
    if (table.startsWith("app_private.") && !providerTables.has(table.slice("app_private.".length))) throw new Error(`Unsupported private application table ${table}. Explicit mapping is required.`);
    // Archive metadata only. Never copy credentials, worker leases, live cursors or queued work.
    for (const row of rows) archive.push({ table, row: archiveRow(row) });
  }
  return { schema: legacy ? "legacy" : "current", owners: [...owners].sort(), tables: output, archive };
}
function sqlValue(value: SqlRow[string]) { return typeof value === "boolean" ? Number(value) : value; }
export function importPrepared(db: ReturnType<typeof openDatabase>, prepared: ReturnType<typeof prepareDump>, fingerprint: string, dryRun: boolean) {
  const ownerRows = prepared.owners.map(id => {
    const row = db.prepare("SELECT id,email FROM owners WHERE id=?").get(id);
    if (!row) throw new Error(`Provision the local account with financial owner UUID ${id} before import.`);
    return row;
  });
  const mappingHash = hash(JSON.stringify(ownerRows));
  const existing = db.prepare("SELECT mapping_hash FROM source_imports WHERE fingerprint=?").get(fingerprint) as { mapping_hash: string } | undefined;
  if (existing) {
    if (existing.mapping_hash !== mappingHash) throw new Error("This source was imported with different account mappings.");
    return { alreadyImported: true, schema: prepared.schema };
  }
  const result = db.transaction(() => {
    for (const table of tables) {
      for (const owner of prepared.owners) {
        if (db.prepare(`SELECT 1 FROM ${table} WHERE owner_id=? LIMIT 1`).get(owner)) throw new Error(`Destination ${table} is not empty for an imported owner. Use a fresh isolated database.`);
      }
      const info = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; type: string; hidden: number }[];
      const permitted = new Set(info.filter(c => !c.hidden).map(c => c.name));
      for (const source of prepared.tables[table]) {
        const row = { ...source };
        if (table === "transactions" && "effective_date" in row) {
          if (row.effective_date !== (row.date_override ?? row.original_date)) throw new Error("Source effective date does not match date override.");
          delete row.effective_date;
        }
        for (const column of Object.keys(row)) if (!permitted.has(column)) throw new Error(`Unsupported field ${table}.${column}; explicit mapping is required.`);
        for (const [column, value] of Object.entries(row)) {
          if (column === "id" || column.endsWith("_id") && column !== "source_id") {
            if (value !== null) z.string().uuid().parse(value);
          }
          if (["month", "original_date", "date_override"].includes(column) && value !== null) dateSchema.parse(value);
          if (column === "month" && !String(value).endsWith("-01")) throw new Error("Budget month must be the first calendar day.");
        }
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table}(${columns.map(c => `"${c}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(c => sqlValue(row[c])));
        const keys = table.startsWith("monthly_budget_") ? ["budget_id", table === "monthly_budget_sections" ? "section_id" : "category_id"] : ["id"];
        const stored = db.prepare(`SELECT * FROM ${table} WHERE ${keys.map(k => `${k}=?`).join(" AND ")}`).get(...keys.map(k => sqlValue(row[k]))) as Record<string, unknown>;
        for (const [column, value] of Object.entries(row)) if (!isDeepStrictEqual(stored[column], sqlValue(value))) throw new Error(`Reconciliation failed: ${table}.${column}.`);
      }
    }
    for (const owner of prepared.owners) {
      const service = new BudgetService(db, owner);
      if (service.rows("SELECT 1 FROM budget_sections WHERE owner_id=? AND kind='income'", owner).length !== 1) throw new Error("Imported owner must have exactly one Income section.");
      for (const t of service.transactions()) validateSplit(t.amount_cents, t.allocations);
      for (const budget of prepared.tables.monthly_budgets.filter(b => b.owner_id === owner)) {
        if (!service.rows("SELECT 1 FROM monthly_budget_sections s JOIN budget_sections c ON c.id=s.section_id WHERE s.budget_id=? AND c.kind='income'", String(budget.id)).length) throw new Error("Imported month is missing its permanent Income snapshot.");
        service.month(String(budget.month).slice(0, 7));
      }
    }
    for (const [index, item] of prepared.archive.entries()) db.prepare("INSERT INTO historical_provider_data(table_name,row_id,value) VALUES(?,?,?)").run(item.table, `${fingerprint}:${index}`, JSON.stringify(item.row));
    const report = {
      alreadyImported: false, schema: prepared.schema, owners: prepared.owners,
      counts: Object.fromEntries(tables.map(t => [t, prepared.tables[t].length])),
      archivedRows: prepared.archive.length,
      monthly: prepared.owners.flatMap(owner => [...new Set(prepared.tables.transactions.filter(t => t.owner_id === owner).map(t => String(t.date_override ?? t.original_date).slice(0, 7)))].sort().map(month => {
        const tx = prepared.tables.transactions.filter(t => t.owner_id === owner && String(t.date_override ?? t.original_date).startsWith(month));
        return { owner, month, transactions: tx.length, signedCents: sum(tx.map(t => Number(t.amount_cents))), includedCents: sum(tx.filter(t => !t.excluded && !t.provider_removed).map(t => Number(t.amount_cents))) };
      })),
      fingerprint, fieldReconciliation: "All imported financial source fields matched stored fields.",
    };
    db.prepare("INSERT INTO source_imports(fingerprint,mapping_hash,imported_at) VALUES(?,?,?)").run(fingerprint, mappingHash, new Date().toISOString());
    if (dryRun) throw new DryRun(report);
    return report;
  });
  try { return result.immediate(); }
  catch (error) { if (error instanceof DryRun) return error.report; throw error; }
}
class DryRun extends Error {
  readonly report: { alreadyImported: boolean; [key: string]: unknown };
  constructor(report: { alreadyImported: boolean; [key: string]: unknown }) { super("Dry-run rollback."); this.report = report; }
}
async function main() {
  const args = process.argv.slice(2), path = args[args.indexOf("--dump") + 1];
  if (!args.includes("--dump") || !path) throw new Error("Usage: budget:import -- --dump <data.sql|backup.gz> [--inspect | --dry-run] --report <private-report.json>");
  const dump = readDump(path), prepared = prepareDump(dump);
  if (args.includes("--inspect")) {
    console.log(JSON.stringify({ schema: prepared.schema, owners: prepared.owners, tables: Object.fromEntries(Object.entries(dump.tables).map(([t, rows]) => [t, rows.length])) }, null, 2));
    return;
  }
  const reportPath = args[args.indexOf("--report") + 1];
  if (!args.includes("--report") || !reportPath || existsSync(reportPath)) throw new Error("Choose a new private report path with --report.");
  const db = openDatabase();
  try {
    const dryRun = args.includes("--dry-run"), fingerprint = hash(JSON.stringify(dump));
    mkdirSync(dirname(resolve(reportPath)), { recursive: true, mode: 0o700 });
    // Reserve the report before committing an import so an existing path never gets overwritten.
    writeFileSync(reportPath, "", { flag: "wx", mode: 0o600 });
    if (!dryRun) await db.backup(`${db.name}.before-import-${Date.now()}.sqlite`);
    const report = importPrepared(db, prepared, fingerprint, dryRun);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(dryRun ? "Dry-run validated and rolled back. Review the private report." : "Import complete. Review the private reconciliation report.");
  } finally { db.close(); }
}
if (process.argv[1]?.endsWith("import.ts")) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Import failed."); process.exitCode = 1; });
}
