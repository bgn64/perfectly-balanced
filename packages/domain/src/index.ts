import Papa from "papaparse";
import { z } from "zod";
export * from "./plaid.ts";

export const MAX_CENTS = 100_000_000_000;
export const centsSchema = z.number().int().min(-MAX_CENTS).max(MAX_CENTS);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    Number(value.slice(0, 4)) > 0 &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  "Use a valid calendar date",
);
export function parseMoney(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter dollars with at most two decimal places (for example -42.50).");
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return centsSchema.parse(match[1] ? -cents : cents);
}
export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents === 0 ? 0 : cents / 100);
}
export function dollars(cents: number): string { return (cents / 100).toFixed(2); }
export function sum(values: number[]): number {
  const result = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(result)) throw new Error("Total exceeds the supported exact-money range.");
  return result;
}
export function localMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
export const sectionSchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["income", "spending"]),
  archived: z.boolean(), position: z.number(),
});
export const categorySchema = z.object({
  id: z.string(), name: z.string(), section_id: z.string(), archived: z.boolean(),
});
export const budgetSectionSchema = z.object({
  section_id: z.string(), name: z.string(), position: z.number(),
});
export const budgetCategorySchema = z.object({
  category_id: z.string(), name: z.string(), planned_cents: centsSchema.nonnegative(), position: z.number(),
});
export const allocationSchema = z.object({
  id: z.string(), category_id: z.string().nullable(), amount_cents: centsSchema,
});
export const transactionSchema = z.object({
  id: z.string(), description: z.string(), merchant: z.string(),
  amount_cents: centsSchema, original_date: dateSchema,
  effective_date: dateSchema, date_override: dateSchema.nullable(),
  excluded: z.boolean(), source: z.string(), allocations: z.array(allocationSchema),
  provider_removed: z.boolean().default(false),
  revision: z.number().int().default(0),
  bank_accounts: z.array(z.object({ institution:z.string(),name:z.string(),mask:z.string().nullable() })).default([]),
});
export const monthSchema = z.object({
  sections: z.array(sectionSchema), categories: z.array(categorySchema),
  budget_sections: z.array(budgetSectionSchema), budget_categories: z.array(budgetCategorySchema),
  transactions: z.array(transactionSchema),
});
export const pageSchema = z.object({
  total: z.number(), items: z.array(transactionSchema),
});
export const suggestionSchema = z.object({
  category_id: z.string(), reason: z.string(),
});
export type Section = z.infer<typeof sectionSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type MonthData = z.infer<typeof monthSchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type AllocationInput = { category_id: string | null; amount_cents: number };
export function validateSplit(amount: number, allocations: AllocationInput[]): void {
  if (!allocations.length) throw new Error("A transaction needs at least one allocation.");
  allocations.forEach((a) => {
    centsSchema.parse(a.amount_cents);
    if (!a.amount_cents) throw new Error("Split amounts must not be zero.");
  });
  if (sum(allocations.map(a => a.amount_cents)) !== amount) {
    throw new Error("Split amounts must sum exactly to the original transaction.");
  }
}
export type Detail = {
  transaction: Transaction; allocation: Allocation; value: number;
};
export type Bucket = {
  id: string; name: string; value: number; unplanned: boolean; details: Detail[]; children: Bucket[];
};
function bucket(id: string, name: string, unplanned = false): Bucket {
  return { id, name, value: 0, unplanned, details: [], children: [] };
}
export function reports(data: MonthData, kind: "income" | "spending", planned: boolean, includeUncategorized: boolean): Bucket[] {
  const sections = new Map<string, Bucket>();
  const sectionMap = new Map(data.sections.map(s => [s.id, s]));
  const categoryMap = new Map(data.categories.map(c => [c.id, c]));
  const budgetSections = new Map(data.budget_sections.map(s => [s.section_id, s]));
  const budgetCategories = new Map(data.budget_categories.map(c => [c.category_id, c]));
  const add = (categoryId: string | null, signedAmount: number, detail?: Detail) => {
    const category = categoryId ? categoryMap.get(categoryId) : undefined;
    if (categoryId && !category) throw new Error("Transaction references an unavailable category.");
    const section = category ? sectionMap.get(category.section_id) : undefined;
    if (category && !section) throw new Error("Category references an unavailable section.");
    const classification = section?.kind ?? (signedAmount > 0 ? "income" : "spending");
    if (classification !== kind || (!category && !includeUncategorized)) return;
    const unplanned = !!category && !budgetCategories.has(category.id);
    const sectionId = !category ? "uncategorized" :
      unplanned && kind === "spending" ? "unplanned" : category.section_id;
    let parent = sections.get(sectionId);
    if (!parent) {
      parent = bucket(sectionId, sectionId === "uncategorized" ? "Uncategorized" :
        sectionId === "unplanned" ? "Unplanned" :
          budgetSections.get(sectionId)?.name ?? section?.name ?? "Unplanned", unplanned);
      sections.set(sectionId, parent);
    }
    const childId = category?.id ?? `uncategorized-${kind}`;
    let child = parent.children.find(c => c.id === childId);
    if (!child) {
      child = bucket(childId, budgetCategories.get(childId)?.name ?? category?.name ?? "Uncategorized", unplanned);
      parent.children.push(child);
    }
    const value = planned ? signedAmount : kind === "spending" ? -signedAmount : signedAmount;
    child.value = sum([child.value, value]);
    parent.value = sum([parent.value, value]);
    if (detail) { child.details.push(detail); parent.details.push(detail); }
  };
  if (planned) {
    for (const c of data.budget_categories) add(c.category_id, c.planned_cents);
  } else {
    for (const t of data.transactions) {
      if (t.excluded || t.provider_removed) continue;
      validateSplit(t.amount_cents, t.allocations);
      for (const a of t.allocations) {
        const c = a.category_id ? categoryMap.get(a.category_id) : undefined;
        const k = c ? sectionMap.get(c.section_id)?.kind : a.amount_cents > 0 ? "income" : "spending";
        add(a.category_id, a.amount_cents, { transaction: t, allocation: a, value: k === "spending" ? -a.amount_cents : a.amount_cents });
      }
    }
  }
  const ordered = [...sections.values()].sort((a, b) =>
    (budgetSections.get(a.id)?.position ?? 1_000_000) - (budgetSections.get(b.id)?.position ?? 1_000_000) || a.name.localeCompare(b.name));
  for (const section of ordered) section.children.sort((a, b) =>
    (budgetCategories.get(a.id)?.position ?? 1_000_000) - (budgetCategories.get(b.id)?.position ?? 1_000_000) || a.name.localeCompare(b.name));
  return ordered;
}
export function categoryActual(data: MonthData, id: string): number {
  return sum(data.transactions.filter(t => !t.excluded && !t.provider_removed).flatMap(t =>
    t.allocations.filter(a => a.category_id === id).map(a => a.amount_cents)));
}
export function canPie(buckets: Bucket[]): boolean {
  return buckets.length > 0 && buckets.every(b => b.value >= 0) && sum(buckets.map(b => b.value)) > 0;
}
export function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export function recommend(target: Pick<Transaction, "merchant" | "description">, history: Transaction[], categories: Category[]): Suggestion | null {
  const active = new Set(categories.filter(c => !c.archived).map(c => c.id));
  for (const field of ["merchant", "description"] as const) {
    const key = normalize(target[field]);
    if (!key) continue;
    const matches = history.filter(t => !t.excluded && !t.provider_removed && normalize(t[field]) === key);
    const scores = new Map<string, { count: number; recent: string }>();
    for (const t of matches) {
      const ids = new Set(t.allocations.map(a => a.category_id));
      if (ids.size !== 1) continue;
      const id = [...ids][0];
      if (!id || !active.has(id)) continue;
      const score = scores.get(id) ?? { count: 0, recent: "" };
      score.count++;
      if (t.effective_date > score.recent) score.recent = t.effective_date;
      scores.set(id, score);
    }
    const ranked = [...scores].sort((a, b) =>
      b[1].count - a[1].count || b[1].recent.localeCompare(a[1].recent) || a[0].localeCompare(b[0]));
    if (ranked[0]) return { category_id: ranked[0][0], reason: `Matches past ${field === "merchant" ? "merchant/payee" : "description"} (${ranked[0][1].count} transactions)` };
  }
  return null;
}
export const sourceInputSchema = z.object({
  original_date: dateSchema, description: z.string().trim().min(1).max(500),
  merchant: z.string().max(200).default(""), amount_cents: centsSchema.refine(n => n !== 0, "Amount must not be zero"),
  external_id: z.string().max(200).optional(),
});
export type SourceInput = z.infer<typeof sourceInputSchema>;
export type CsvPreview = { rows: SourceInput[]; errors: string[] };
export function parseCsv(text: string): CsvPreview {
  const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: "greedy", transformHeader: h => h.trim() });
  const errors = result.errors.map(e => `CSV ${e.row === undefined ? "" : `row ${e.row + 2}: `}${e.message}`);
  const fields = result.meta.fields ?? [];
  if (!["date", "description", "amount"].every(f => fields.includes(f))) {
    errors.push("Required CSV headers: date, description, amount. Optional: merchant, external_id.");
  }
  const rows: SourceInput[] = [];
  const ids = new Set<string>();
  for (const [index, row] of result.data.entries()) {
    try {
      const input = sourceInputSchema.parse({
        original_date: row.date, description: row.description,
        amount_cents: parseMoney(row.amount ?? ""), merchant: row.merchant ?? "",
        external_id: row.external_id?.trim() || undefined,
      });
      if (input.external_id && ids.has(input.external_id)) throw new Error("Duplicate external_id within this file.");
      if (input.external_id) ids.add(input.external_id);
      rows.push(input);
    } catch (e) {
      errors.push(`Row ${index + 2}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!result.data.length) errors.push("The CSV contains no transactions.");
  if (result.data.length > 1000) errors.push("Import at most 1,000 transactions per file.");
  return { rows, errors };
}
