import { importSql, literal, type MigrationPlan } from "./legacy.ts";

const legacyTables = [
  "transaction_category_splits", "budget_category_allocations", "budget_subsections",
  "budgets", "transactions", "plaid_webhook_events", "plaid_items", "categories",
];
const legacyFunctions = [
  "add_budget_subsection(uuid,text)",
  "apply_plaid_transaction_sync(uuid,text,jsonb,jsonb,text[],boolean,boolean)",
  "apply_transaction_recommendations(uuid,uuid,boolean,boolean)",
  "claim_plaid_item_sync(uuid)",
  "clear_splits_after_transaction_amount_change()",
  "copy_previous_month_budget(date)",
  "create_budget_category_allocation(uuid,uuid,uuid,numeric,text)",
  "create_budget_category_allocation_at_position(uuid,uuid,uuid,integer)",
  "create_budget_category_allocation_at_position(uuid,text,uuid,integer)",
  "create_budget_subsection_at_position(uuid,text,integer)",
  "create_category_with_root_budget_allocation(uuid,text)",
  "create_monthly_budget(date)",
  "create_plaid_item(uuid,text,text,text,text)",
  "delete_budget_subsection(uuid)",
  "delete_disconnected_plaid_history(uuid,uuid)",
  "disconnect_plaid_item(uuid,uuid)",
  "get_plaid_item_token_for_user(uuid,uuid)",
  "place_budget_category_allocation(uuid,uuid,integer)",
  "place_budget_subsection(uuid,integer)",
  "record_plaid_item_sync_failure(uuid,text)",
  "remove_budget_allocation(uuid)",
  "rename_budget_subsection(uuid,text)",
  "replace_transaction_category_splits(uuid,jsonb)",
  "revoke_plaid_account_from_webhook(uuid,text)",
  "revoke_plaid_item_from_webhook(uuid,text)",
  "set_transaction_budget_date(uuid,date)",
  "set_transaction_ignored(uuid,boolean)",
  "update_budget_category_allocation(uuid,numeric,text)",
  "validate_usd_transaction_category_split()",
];
const newFunctions = [
  "app_demo(text)", "app_month(text)", "app_page(text,text,boolean,text,uuid,integer,text)",
  "app_history(uuid)", "app_mutate(text,jsonb)", "app_import_preview(text,jsonb)",
];
const privateFunctions = [
  "transaction_json(public.transactions)", "guard_catalog()", "check_allocations()",
  "require_user()", "month_date(text)", "ensure_month(uuid,date)", "put_transaction(uuid,jsonb,text,text)",
];
export type MigrationFile = { filename: string; sql: string };
export function isCutoverMigration(filename: string): boolean {
  return /^\d{14}_[a-z_]+\.sql$/.test(filename) && filename.slice(0,14)<="20261002000500";
}

export function replacementSql(plan: MigrationPlan, legacyVersions: string[], migrations: MigrationFile[]): string {
  if (!legacyVersions.length || !legacyVersions.every(v => /^\d{14}$/.test(v))) throw new Error("Invalid legacy migration ledger.");
  if (!migrations.length || !migrations.every(m => isCutoverMigration(m.filename))) throw new Error("Invalid replacement migration files; cutover must use its frozen schema, not live ingestion migrations.");
  const allowedNames = [...new Set(legacyFunctions.map(f => f.split("(")[0])), "rls_auto_enable"];
  const ledger = legacyVersions.map(literal).sort().join(",");
  return [
    "-- One-time destructive app-schema replacement. Separate production approval is mandatory.",
    "-- Auth users, Vault, managed schemas, and managed event triggers are not dropped.",
    `-- Expected project: ${plan.project_ref}; source SHA-256: ${plan.source_hash}`,
    "begin;",
    "set local lock_timeout='10s';",
    "set local statement_timeout='120s';",
    "do $replacement_guard$ begin",
    `if (select array_agg(version order by version) from supabase_migrations.schema_migrations) is distinct from array[${ledger}]::text[] then raise exception 'Unexpected legacy migration history'; end if;`,
    "if exists(select 1 from pg_namespace where nspname='app_private') then raise exception 'Replacement schema already exists'; end if;",
    `if exists(select 1 from auth.users where id<>${literal(plan.user_id)}) or not exists(select 1 from auth.users where id=${literal(plan.user_id)}) then raise exception 'Unexpected auth user identity'; end if;`,
    "if exists(select 1 from public.plaid_items where status<>'disconnected' or vault_secret_id is not null or sync_started_at is not null) then raise exception 'Plaid must be disconnected and quiescent before replacement'; end if;",
    `if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname not in (${allowedNames.map(literal).join(",")})) then raise exception 'Unexpected public function'; end if;`,
    `if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname<>'rls_auto_enable')<>${legacyFunctions.length} then raise exception 'Unexpected legacy function overloads'; end if;`,
    ...legacyFunctions.map(fn => `if to_regprocedure(${literal(`public.${fn}`)}) is null then raise exception 'Expected legacy function is missing'; end if;`),
    `if exists(select 1 from information_schema.tables where table_schema='public' and table_name not in (${[...legacyTables, "budget_category_activity"].map(literal).join(",")})) then raise exception 'Unexpected public relation'; end if;`,
    "end $replacement_guard$;",
    "lock table public.transaction_category_splits,public.budget_category_allocations,public.budget_subsections,public.budgets,public.transactions,public.plaid_webhook_events,public.plaid_items,public.categories in access exclusive mode;",
    "drop view public.budget_category_activity;",
    ...legacyTables.map(table => `drop table public.${table};`),
    ...legacyFunctions.map(fn => `drop function public.${fn};`),
    ...migrations.map(m => m.sql),
    importSql(plan, false),
    `delete from supabase_migrations.schema_migrations where version in (${ledger});`,
    ...migrations.map(m => {
      const version = m.filename.slice(0, 14);
      const name = m.filename.slice(15, -4);
      return `insert into supabase_migrations.schema_migrations(version,name,statements) values (${literal(version)},${literal(name)},array[${literal(m.sql)}]);`;
    }),
    "notify pgrst,'reload schema';",
    "commit;",
    "",
  ].join("\n");
}

export function rollbackSql(plan: MigrationPlan, schemaBackup: string, dataBackup: string): string {
  if (!schemaBackup.includes('CREATE TABLE IF NOT EXISTS "public"."transactions"') ||
      !dataBackup.includes('COPY "public"."transactions"')) throw new Error("Legacy rollback backups are missing expected tables.");
  return [
    "-- Restores the legacy app and migration history, without reactivating revoked bank connections.",
    "-- Use the old frontend revision after database restoration. Auth and Vault are preserved.",
    "begin;",
    "set local lock_timeout='10s';",
    ...newFunctions.map(fn => `drop function public.${fn};`),
    `drop function app_private.${privateFunctions[0]};`,
    "drop table public.transaction_allocations;",
    "drop table public.import_batches;",
    "drop table public.monthly_budget_categories;",
    "drop table public.monthly_budget_sections;",
    "drop table public.monthly_budgets;",
    "drop table public.categories;",
    "drop table public.budget_sections;",
    "drop table public.transactions;",
    ...privateFunctions.slice(1).map(fn => `drop function app_private.${fn};`),
    "drop schema app_private;",
    "drop table supabase_migrations.schema_migrations;",
    schemaBackup,
    dataBackup,
    "set session_replication_role=origin;",
    "update public.plaid_items set status='disconnected',vault_secret_id=null,sync_started_at=null,disconnected_at=coalesce(disconnected_at,now());",
    `do $rollback_guard$ begin if not exists(select 1 from auth.users where id=${literal(plan.user_id)}) then raise exception 'Auth user was not preserved'; end if; end $rollback_guard$;`,
    "notify pgrst,'reload schema';",
    "commit;",
    "",
  ].join("\n");
}
