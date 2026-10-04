import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertImported, transformLegacy, verificationSql, snapshotSchema } from "./legacy.ts";
import { replacementSql, rollbackSql, isCutoverMigration } from "./replacement.ts";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  console.error("Usage: npm run cutover:rehearse-replacement -- <private-backup-directory>");
  process.exit(1);
}
if ((statSync(directory).mode & 0o077) !== 0) throw new Error("Backup directory must have mode 0700.");
const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(resolve(directory, "legacy.json"), "utf8")));
const plan = transformLegacy(snapshot);
const schema = readFileSync(resolve(directory, "legacy-schema.sql"), "utf8");
const data = readFileSync(resolve(directory, "legacy-data.sql"), "utf8");
const migrations = readdirSync(resolve("supabase/migrations")).filter(isCutoverMigration).sort()
  .map(filename => ({ filename, sql: readFileSync(resolve("supabase/migrations", filename), "utf8") }));
const replacement = replacementSql(plan, snapshot.migration_versions, migrations);
const rollback = rollbackSql(plan, schema, data);
const database = `cutover_replacement_${plan.source_hash.slice(0, 12)}`;
const container = "supabase_db_perfectly-balanced";
const args = (db: string) => ["exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-At"];
function sql(query: string, db = database): string {
  try {
    return execFileSync("docker", args(db), { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      writeFileSync(resolve(directory, "replacement-error.log"), String(error.stderr), { flag: "wx", mode: 0o600 });
    }
    throw new Error(`Replacement rehearsal failed. Inspect the private replacement-error.log; database ${database} is retained.`);
  }
}
const legacyFieldChecks = () => {
  const restoredRows: Record<string, unknown> = {};
  const sources = [
    ["budgets", "budgets", "b.month,b.id", false],
    ["subsections", "budget_subsections", "b.budget_id,b.position,b.id", false],
    ["categories", "categories", "b.id", false],
    ["budget_allocations", "budget_category_allocations", "b.id", true],
    ["transactions", "transactions", "b.id", true],
    ["splits", "transaction_category_splits", "b.id", true],
  ] as const;
  for (const [key, table, order, amount] of sources) {
    const row = amount ? "to_jsonb(b)||jsonb_build_object('amount',b.amount::text)" : "to_jsonb(b)";
    restoredRows[key] = JSON.parse(sql(`select coalesce(jsonb_agg(${row} order by ${order}),'[]'::jsonb) from public.${table} b`).trim());
  }
  const restored = transformLegacy({ ...snapshot, ...restoredRows });
  if (!isDeepStrictEqual(restored.tables, plan.tables)) throw new Error("Restored financial fields differ from the export.");
  const versions = JSON.parse(sql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations").trim());
  if (!isDeepStrictEqual(versions, snapshot.migration_versions)) throw new Error("Restored legacy migration ledger differs from the export.");
};
try {
  if (sql(`select count(*) from pg_database where datname='${database}'`, "postgres").trim() !== "0") throw new Error("Replacement rehearsal database already exists; it will not be overwritten.");
  sql(`create database ${database}`, "postgres");
  sql(`create schema auth;
create schema extensions;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;
create function auth.role() returns text language sql stable as $$select current_setting('role',true);$$;
insert into auth.users(id) values ('${plan.user_id}');`);
  sql(schema);
  sql(data);
  sql("set session_replication_role=origin;");
  legacyFieldChecks();
  const disconnected = "update public.plaid_items set status='disconnected',vault_secret_id=null,sync_started_at=null,disconnected_at=now();";
  sql(disconnected);
  const failed = spawnSync("docker", args(database), {
    input: replacement.replace(/\ncommit;\n$/, "\nselect 1/0;\ncommit;\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (failed.error) throw failed.error;
  if (failed.status === 0 || !failed.stderr.includes("division by zero")) {
    writeFileSync(resolve(directory, "replacement-failure.log"), failed.stderr, { flag: "wx", mode: 0o600 });
    throw new Error("Injected failure did not reach the expected rollback check. Inspect the private replacement-failure.log.");
  }
  legacyFieldChecks();
  sql(replacement);
  assertImported(plan, JSON.parse(sql(`${verificationSql(plan)};`).trim()));
  const newVersions = JSON.parse(sql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations").trim());
  if (!isDeepStrictEqual(newVersions, migrations.map(m => m.filename.slice(0, 14)))) throw new Error("New migration ledger mismatch.");
  sql(rollback);
  legacyFieldChecks();
  if (sql("select count(*) from public.plaid_items where status<>'disconnected' or vault_secret_id is not null").trim() !== "0") {
    throw new Error("Rollback must not restore revoked bank connections.");
  }
  writeFileSync(resolve(directory, "prepared/replacement.sql"), replacement, { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(directory, "prepared/rollback.sql"), rollback, { flag: "wx", mode: 0o600 });
  writeFileSync(resolve(directory, "replacement-rehearsal.json"), `${JSON.stringify({
    database, source_hash: plan.source_hash, verified: ["legacy backup restore", "injected failure rolls back schema and data",
      "new import exact reconciliation", "new migration ledger", "committed replacement rollback", "legacy migration ledger restored", "revoked connections remain disconnected"],
    limitation: "Local Auth scaffold; hosted deployment/auth email and managed event triggers require separate validation.",
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Verified legacy restore, atomic replacement, exact reconciliation, migration ledgers, and rollback in ${database}.`);
  console.log("Generated production operations remain private and require separate explicit approval.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Replacement rehearsal failed with an unknown error.");
  process.exitCode = 1;
}
