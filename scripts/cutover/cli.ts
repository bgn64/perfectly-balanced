import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { assertImported, importSql, transformLegacy, verificationSql } from "./legacy.ts";

const projectRef = "hqeoxulnpkksxvoyxlvq";
const queryResult = z.object({ rows: z.array(z.record(z.string(), z.unknown())) });
function query(sql: string, local: boolean) {
  const target = local ? ["--local"] : ["--linked", "--project-ref", projectRef];
  return queryResult.parse(JSON.parse(execFileSync("npx", [
    "--no-install", "supabase", "db", "query", ...target, sql, "--output", "json",
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))).rows;
}
function privateWrite(path: string, content: string) {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Export directory must be private (chmod 700) and not a symlink.");
  writeFileSync(resolve(path), content, { flag: "wx", mode: 0o600 });
}
const exportSql = `select jsonb_build_object(
  'format',1,'project_ref','${projectRef}','exported_at',now(),
  'user_id',(select id from auth.users),
  'budgets',(select coalesce(jsonb_agg(b order by b.month,b.id),'[]'::jsonb) from public.budgets b),
  'subsections',(select coalesce(jsonb_agg(s order by s.budget_id,s.position,s.id),'[]'::jsonb) from public.budget_subsections s),
  'categories',(select coalesce(jsonb_agg(c order by c.id),'[]'::jsonb) from public.categories c),
  'budget_allocations',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('amount',a.amount::text) order by a.id),'[]'::jsonb) from public.budget_category_allocations a),
  'transactions',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('amount',t.amount::text) order by t.id),'[]'::jsonb) from public.transactions t),
  'splits',(select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('amount',s.amount::text) order by s.id),'[]'::jsonb) from public.transaction_category_splits s),
  'migration_versions',(select coalesce(jsonb_agg(version order by version),'[]'::jsonb) from supabase_migrations.schema_migrations)
) as snapshot`;

const [command, inputPath, outputPath] = process.argv.slice(2);
try {
  if (command === "export") {
    if (!inputPath || outputPath) throw new Error("Usage: npm run cutover -- export backups/<snapshot>/legacy.json");
    const result = query(exportSql, false);
    const snapshot = z.object({
      project_ref: z.literal(projectRef), user_id: z.string().uuid(),
      transactions: z.array(z.unknown()), categories: z.array(z.unknown()), budgets: z.array(z.unknown()),
    }).passthrough().parse(result[0]?.snapshot);
    privateWrite(inputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`Exported ${snapshot.transactions.length} transactions, ${snapshot.categories.length} categories, and ${snapshot.budgets.length} budgets to a private snapshot. Compatibility is checked separately by prepare.`);
  } else if (command === "prepare") {
    if (!inputPath || !outputPath) throw new Error("Usage: npm run cutover -- prepare <snapshot.json> <private-output-directory>");
    const plan = transformLegacy(JSON.parse(readFileSync(inputPath, "utf8")));
    privateWrite(resolve(outputPath, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    privateWrite(resolve(outputPath, "import.sql"), importSql(plan));
    console.log(`Prepared a deterministic import for ${plan.summary.transactions} transactions. Review private plan.json for reconciliation totals.`);
  } else if (command === "verify-local") {
    if (!inputPath || outputPath) throw new Error("Usage: npm run cutover -- verify-local <snapshot.json>");
    const plan = transformLegacy(JSON.parse(readFileSync(inputPath, "utf8")));
    assertImported(plan, query(verificationSql(plan), true)[0]?.imported);
    console.log("Every imported record and financial field matches the validated legacy snapshot.");
  } else {
    throw new Error("Usage: npm run cutover -- export|prepare|verify-local <paths>. This tool never applies production SQL.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cutover failed with an unknown error.");
  process.exitCode = 1;
}
