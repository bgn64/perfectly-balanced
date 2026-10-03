import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { dateSchema, parseMoney, sum, validateSplit } from "../../packages/domain/src/index.ts";

const id = z.string().uuid();
const owner = z.object({ id, user_id: id });
const name = z.string().trim().min(1).max(100);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
export const snapshotSchema = z.object({
  format: z.literal(1),
  project_ref: z.literal("hqeoxulnpkksxvoyxlvq"),
  exported_at: z.string(),
  user_id: id,
  budgets: z.array(owner.extend({ month: dateSchema }).passthrough()),
  subsections: z.array(owner.extend({ budget_id: id, name, position: z.number().int().nonnegative() }).passthrough()),
  categories: z.array(owner.extend({ name }).passthrough()),
  budget_allocations: z.array(owner.extend({
    budget_id: id, category_id: id, subsection_id: id.nullable(), amount: decimal,
    direction: z.enum(["income", "spending"]), position: z.number().int().nonnegative(),
  }).passthrough()),
  transactions: z.array(owner.extend({
    source_transaction_id: z.string().min(1),
    transaction_date: dateSchema, transaction_date_override: dateSchema.nullable(),
    merchant_name: z.string().nullable(), transaction_name: z.string().nullable(),
    amount: decimal, currency_code: z.literal("USD"), is_pending: z.boolean(),
    is_ignored: z.boolean(), created_at: z.string().min(1),
  }).passthrough()),
  splits: z.array(owner.extend({ transaction_id: id, category_id: id, amount: decimal }).passthrough()),
  migration_versions: z.array(z.string().regex(/^\d{14}$/)),
});
export type LegacySnapshot = z.infer<typeof snapshotSchema>;
export type SqlRow = Record<string, string | number | boolean | null>;
export const tableNames = [
  "budget_sections", "categories", "monthly_budgets", "monthly_budget_sections",
  "monthly_budget_categories", "transactions", "transaction_allocations",
] as const;
export type TableName = typeof tableNames[number];
const tableColumns: Record<TableName, string[]> = {
  budget_sections: ["id", "owner_id", "name", "kind", "archived", "position"],
  categories: ["id", "owner_id", "section_id", "name", "archived"],
  monthly_budgets: ["id", "owner_id", "month"],
  monthly_budget_sections: ["owner_id", "budget_id", "section_id", "name", "position"],
  monthly_budget_categories: ["owner_id", "budget_id", "category_id", "section_id", "name", "planned_cents", "position"],
  transactions: ["id", "owner_id", "description", "merchant", "amount_cents", "currency", "original_date", "date_override", "excluded", "source", "source_id", "created_at"],
  transaction_allocations: ["id", "owner_id", "transaction_id", "category_id", "amount_cents"],
};
export type MigrationPlan = {
  format: 1;
  project_ref: LegacySnapshot["project_ref"];
  user_id: string;
  source_hash: string;
  tables: Record<TableName, SqlRow[]>;
  summary: {
    budgets: number; categories: number; transactions: number; legacy_splits: number;
    uncategorized_allocations: number; pending_imported_as_ordinary: number;
    exclusions: number; date_overrides: number; unplaced_categories: number;
    transaction_cents: number; assigned_cents: number; uncategorized_cents: number;
    planned_cents: number;
  };
};

function uuid(key: string): string {
  const namespace = Buffer.from("9343dac8c2fa43ff9333a8f6756c8a10", "hex");
  const bytes = createHash("sha1").update(namespace).update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function exactCents(value: string): number {
  const normalized = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  return parseMoney(normalized);
}

function indexed<T extends { id: string; user_id: string }>(rows: T[], userId: string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (row.user_id !== userId) throw new Error(`${label}: cross-user record ${row.id}.`);
    if (result.has(row.id)) throw new Error(`${label}: duplicate ID ${row.id}.`);
    result.set(row.id, row);
  }
  return result;
}

export function transformLegacy(input: unknown): MigrationPlan {
  const source = snapshotSchema.parse(input);
  const budgets = indexed(source.budgets, source.user_id, "Budgets");
  const subsections = indexed(source.subsections, source.user_id, "Subsections");
  const categories = indexed(source.categories, source.user_id, "Categories");
  const transactions = indexed(source.transactions, source.user_id, "Transactions");
  indexed(source.budget_allocations, source.user_id, "Budget allocations");
  indexed(source.splits, source.user_id, "Splits");
  const months = new Set<string>();
  for (const budget of budgets.values()) {
    if (!budget.month.endsWith("-01") || months.has(budget.month)) throw new Error("Invalid or duplicate budget month.");
    months.add(budget.month);
  }
  for (const subsection of subsections.values()) {
    if (!budgets.has(subsection.budget_id)) throw new Error(`Subsection ${subsection.id} references a missing budget.`);
  }
  const tables: MigrationPlan["tables"] = {
    budget_sections: [], categories: [], monthly_budgets: [], monthly_budget_sections: [],
    monthly_budget_categories: [], transactions: [], transaction_allocations: [],
  };
  const sectionIds = new Map<string, string>();
  const sectionId = (kind: "income" | "spending", sectionName: string) => {
    const key = JSON.stringify([kind, sectionName]);
    let value = sectionIds.get(key);
    if (!value) {
      value = uuid(`${source.user_id}:section:${key}`);
      sectionIds.set(key, value);
      tables.budget_sections.push({
        id: value, owner_id: source.user_id, name: sectionName, kind, archived: false,
        position: tables.budget_sections.length,
      });
    }
    return value;
  };
  const incomeId = sectionId("income", "Income");
  const placements = new Map<string, { sectionId: string; direction: "income" | "spending" }>();
  const budgetCategoryKeys = new Set<string>();
  for (const allocation of source.budget_allocations) {
    if (!budgets.has(allocation.budget_id) || !categories.has(allocation.category_id)) {
      throw new Error(`Budget allocation ${allocation.id} has a missing reference.`);
    }
  }
  const orderedAllocations = [...source.budget_allocations].sort((a, b) =>
    budgets.get(a.budget_id)!.month.localeCompare(budgets.get(b.budget_id)!.month) ||
    (subsections.get(a.subsection_id ?? "")?.position ?? a.position) -
      (subsections.get(b.subsection_id ?? "")?.position ?? b.position) ||
    a.position - b.position || a.id.localeCompare(b.id));
  for (const allocation of orderedAllocations) {
    const subsection = allocation.subsection_id ? subsections.get(allocation.subsection_id) : null;
    if (allocation.subsection_id && (!subsection || subsection.budget_id !== allocation.budget_id)) {
      throw new Error(`Budget allocation ${allocation.id} has an invalid subsection.`);
    }
    const cents = exactCents(allocation.amount);
    if ((allocation.direction === "income" && cents < 0) || (allocation.direction === "spending" && cents > 0)) {
      throw new Error(`Budget allocation ${allocation.id} has an incompatible direction.`);
    }
    const sid = allocation.direction === "income" ? incomeId : sectionId("spending", subsection?.name ?? "General");
    const existing = placements.get(allocation.category_id);
    if (existing && (existing.sectionId !== sid || existing.direction !== allocation.direction)) {
      throw new Error(`Category ${allocation.category_id} changes section/direction across months; explicit mapping approval is required.`);
    }
    placements.set(allocation.category_id, { sectionId: sid, direction: allocation.direction });
    const key = `${allocation.budget_id}:${allocation.category_id}`;
    if (budgetCategoryKeys.has(key)) throw new Error("Duplicate monthly category allocation.");
    budgetCategoryKeys.add(key);
    tables.monthly_budget_categories.push({
      owner_id: source.user_id, budget_id: allocation.budget_id, category_id: allocation.category_id,
      section_id: sid, name: categories.get(allocation.category_id)!.name,
      planned_cents: Math.abs(cents), position: tables.monthly_budget_categories.filter(c =>
        c.budget_id === allocation.budget_id && c.section_id === sid).length,
    });
  }
  let unplaced = 0;
  for (const category of categories.values()) {
    let placement = placements.get(category.id);
    if (!placement) {
      unplaced++;
      placement = { sectionId: sectionId("spending", "General"), direction: "spending" };
    }
    tables.categories.push({
      id: category.id, owner_id: source.user_id, section_id: placement.sectionId,
      name: category.name, archived: false,
    });
  }
  for (const budget of budgets.values()) {
    tables.monthly_budgets.push({ id: budget.id, owner_id: source.user_id, month: budget.month });
    const monthlySections = new Map<string, { name: string; order: number }>([[incomeId, { name: "Income", order: -1 }]]);
    const addMonthly = (sid: string, sectionName: string, order: number) => {
      const existing = monthlySections.get(sid);
      if (!existing || order < existing.order) monthlySections.set(sid, { name: sectionName, order });
    };
    for (const subsection of subsections.values()) {
      if (subsection.budget_id !== budget.id) continue;
      const allocations = source.budget_allocations.filter(a => a.subsection_id === subsection.id);
      if (!allocations.length || allocations.some(a => a.direction === "spending")) {
        addMonthly(sectionId("spending", subsection.name), subsection.name, subsection.position);
      }
    }
    for (const allocation of source.budget_allocations.filter(a => a.budget_id === budget.id && a.direction === "spending")) {
      const subsection = allocation.subsection_id ? subsections.get(allocation.subsection_id) : null;
      addMonthly(placements.get(allocation.category_id)!.sectionId, subsection?.name ?? "General",
        subsection?.position ?? allocation.position);
    }
    [...monthlySections].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0])).forEach(([sid, section], position) => {
      tables.monthly_budget_sections.push({
        owner_id: source.user_id, budget_id: budget.id, section_id: sid, name: section.name, position,
      });
    });
  }
  const splitsByTransaction = new Map<string, LegacySnapshot["splits"]>();
  for (const split of source.splits) {
    if (!transactions.has(split.transaction_id) || !categories.has(split.category_id)) {
      throw new Error(`Split ${split.id} has a missing reference.`);
    }
    const splits = splitsByTransaction.get(split.transaction_id) ?? [];
    if (splits.some(s => s.category_id === split.category_id)) throw new Error("Duplicate category in legacy splits.");
    splits.push(split);
    splitsByTransaction.set(split.transaction_id, splits);
  }
  const sourceIds = new Set<string>();
  let remainders = 0;
  for (const transaction of transactions.values()) {
    if (sourceIds.has(transaction.source_transaction_id)) throw new Error("Duplicate legacy source transaction ID.");
    sourceIds.add(transaction.source_transaction_id);
    const description = transaction.merchant_name?.trim() || transaction.transaction_name?.trim();
    const merchant = transaction.merchant_name ?? "";
    if (!description || description.length > 500 || merchant.length > 200) {
      throw new Error(`Transaction ${transaction.id} has an unsupported description/merchant.`);
    }
    const amount = exactCents(transaction.amount);
    if (!amount) throw new Error(`Transaction ${transaction.id} has a zero amount.`);
    const allocations = (splitsByTransaction.get(transaction.id) ?? []).map(split => ({
      id: split.id, owner_id: source.user_id, transaction_id: transaction.id,
      category_id: split.category_id, amount_cents: exactCents(split.amount),
    }));
    const remainder = sum([amount, -sum(allocations.map(a => a.amount_cents))]);
    if (remainder) {
      remainders++;
      const allocation = {
        id: uuid(`${source.user_id}:remainder:${transaction.id}`), owner_id: source.user_id,
        transaction_id: transaction.id, category_id: null, amount_cents: remainder,
      };
      validateSplit(amount, [...allocations, allocation]);
      tables.transaction_allocations.push(...allocations, allocation);
    } else {
      validateSplit(amount, allocations);
      tables.transaction_allocations.push(...allocations);
    }
    tables.transactions.push({
      id: transaction.id, owner_id: source.user_id, description, merchant, amount_cents: amount,
      currency: "USD", original_date: transaction.transaction_date, date_override: transaction.transaction_date_override,
      excluded: transaction.is_ignored, source: "plaid", source_id: transaction.source_transaction_id,
      created_at: transaction.created_at,
    });
  }
  return {
    format: 1, project_ref: source.project_ref, user_id: source.user_id,
    source_hash: createHash("sha256").update(JSON.stringify(source)).digest("hex"), tables,
    summary: {
      budgets: budgets.size, categories: categories.size, transactions: transactions.size,
      legacy_splits: source.splits.length, uncategorized_allocations: remainders,
      pending_imported_as_ordinary: source.transactions.filter(t => t.is_pending).length,
      exclusions: source.transactions.filter(t => t.is_ignored).length,
      date_overrides: source.transactions.filter(t => t.transaction_date_override !== null).length,
      unplaced_categories: unplaced,
      transaction_cents: sum(source.transactions.map(t => exactCents(t.amount))),
      assigned_cents: sum(source.splits.map(s => exactCents(s.amount))),
      uncategorized_cents: sum(tables.transaction_allocations.filter(a => a.category_id === null).map(a => Number(a.amount_cents))),
      planned_cents: sum(source.budget_allocations.map(a => Math.abs(exactCents(a.amount)))),
    },
  };
}

export function literal(value: SqlRow[string]): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("SQL number is not an exact integer.");
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function importSql(plan: MigrationPlan, transaction = true): string {
  const uid = literal(plan.user_id);
  const guard = [...tableNames, "import_batches"].map(table =>
    `if exists(select 1 from public.${table} where owner_id=${uid}) then raise exception 'Cutover requires an empty destination for this user (${table})'; end if;`).join("\n");
  const statements = tableNames.flatMap(table => plan.tables[table].map(row => {
    const columns = Object.keys(row);
    if (columns.length !== tableColumns[table].length || !columns.every(c => tableColumns[table].includes(c))) {
      throw new Error(`Invalid SQL columns for ${table}.`);
    }
    return `insert into public.${table} (${columns.join(",")}) values (${columns.map(c => literal(row[c])).join(",")});`;
  }));
  return [
    "-- Administrator-only import generated from a validated legacy snapshot. Rehearse locally before production use.",
    `-- Expected project: ${plan.project_ref}; source SHA-256: ${plan.source_hash}`,
    ...(transaction ? ["begin;"] : []),
    "set local standard_conforming_strings = on;",
    "set constraints all deferred;",
    "do $cutover_guard$ begin",
    `if not exists(select 1 from auth.users where id=${uid}) then raise exception 'Expected legacy auth user is missing'; end if;`,
    guard,
    "end $cutover_guard$;",
    ...statements,
    `insert into public.import_batches (owner_id,fingerprint) values (${uid},${literal(`legacy-cutover:${plan.source_hash}`)});`,
    "set constraints all immediate;",
    ...(transaction ? ["commit;"] : []),
    "",
  ].join("\n");
}

export function verificationSql(plan: MigrationPlan): string {
  const parts = tableNames.flatMap(table => {
    const projection = tableColumns[table].join(",");
    return [literal(table), `(select coalesce(jsonb_agg(r), '[]'::jsonb) from (select ${projection} from public.${table} where owner_id=${literal(plan.user_id)}) r)`];
  });
  parts.push("'fingerprints'", `(select coalesce(jsonb_agg(fingerprint), '[]'::jsonb) from public.import_batches where owner_id=${literal(plan.user_id)})`);
  return `select jsonb_build_object(${parts.join(",")}) as imported`;
}

export function assertImported(plan: MigrationPlan, input: unknown): void {
  const imported = z.record(z.string(), z.unknown()).parse(input);
  const sorted = (rows: unknown) => z.array(z.record(z.string(), z.unknown())).parse(rows)
    .map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const table of tableNames) {
    if (!isDeepStrictEqual(sorted(imported[table]), sorted(plan.tables[table]))) {
      throw new Error(`Reconciliation failed for ${table}. No financial records have been printed.`);
    }
  }
  if (!isDeepStrictEqual(imported.fingerprints, [`legacy-cutover:${plan.source_hash}`])) throw new Error("Cutover fingerprint mismatch.");
}
