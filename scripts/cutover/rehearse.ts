import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertImported, importSql, transformLegacy, verificationSql } from "./legacy.ts";

const snapshotPath = process.argv[2];
if (!snapshotPath || process.argv.length !== 3) {
  console.error("Usage: npm run cutover:rehearse -- <private-snapshot.json>");
  process.exit(1);
}
const container = "supabase_db_perfectly-balanced";
const plan = transformLegacy(JSON.parse(readFileSync(snapshotPath, "utf8")));
const database = `cutover_rehearsal_${plan.source_hash.slice(0, 12)}`;
function sql(query: string, db = database): string {
  try {
    return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", db,
      "-v", "ON_ERROR_STOP=1", "-At"], { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "Unknown database error";
    throw new Error(`Isolated rehearsal SQL failed: ${message}. Database ${database} is retained for inspection.`);
  }
}
try {
  if (sql(`select count(*) from pg_database where datname='${database}'`, "postgres").trim() !== "0") {
    throw new Error(`Rehearsal database ${database} already exists. It will not be overwritten.`);
  }
  sql(`create database ${database}`, "postgres");
  sql(`create schema auth;
create schema extensions;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
insert into auth.users(id) values ('${plan.user_id}');`);
  const migrations = readdirSync(resolve("supabase/migrations")).filter(f => /^\d{14}_[a-z_]+\.sql$/.test(f)).sort();
  if (!migrations.length) throw new Error("New schema migrations are missing.");
  for (const migration of migrations) sql(readFileSync(resolve("supabase/migrations", migration), "utf8"));
  sql(importSql(plan));
  assertImported(plan, JSON.parse(sql(`${verificationSql(plan)};`).trim()));

  const transactionCount = sql(`set role authenticated;
set request.jwt.claim.sub='${plan.user_id}';
select count(*) from public.transactions;`).trim().split("\n").at(-1);
  if (transactionCount !== String(plan.summary.transactions)) throw new Error("Owner-scoped authenticated read failed.");
  const outsiderCount = sql(`set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select count(*) from public.transactions;`).trim().split("\n").at(-1);
  if (outsiderCount !== "0") throw new Error("Owner isolation failed.");

  const duplicate = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-At"], { input: importSql(plan), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (duplicate.error) throw duplicate.error;
  if (duplicate.status === 0 || !duplicate.stderr.includes("Cutover requires an empty destination")) {
    throw new Error("Duplicate import was not rejected by the expected guard.");
  }
  assertImported(plan, JSON.parse(sql(`${verificationSql(plan)};`).trim()));

  const manifest = {
    database, container, source_hash: plan.source_hash,
    verified: ["all imported rows and fields", "owner reads", "cross-owner RLS", "duplicate import rejected without data changes"],
    limitation: "Standalone database with minimal Auth schema; this does not verify legacy schema replacement or full rollback.",
  };
  writeFileSync(resolve(dirname(snapshotPath), "rehearsal.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Verified every imported record, owner isolation, and rerun protection in ${database}.`);
  console.log("The user's existing local database and production financial data were not modified.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Rehearsal failed with an unknown error.");
  process.exitCode = 1;
}
