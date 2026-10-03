import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  monthSchema, pageSchema, transactionSchema, sourceInputSchema, validateSplit,
  recommend, type MonthData, type Transaction, type AllocationInput, type SourceInput,
} from "@balanced/domain";
import type { Database } from "./database.types";

export type Command =
  | { action: "section_add"; month: string; name: string }
  | { action: "section_attach" | "category_attach" | "remove_category" | "remove_section"; month: string; id: string }
  | { action: "category_add"; month: string; section_id: string; name: string; planned_cents: number }
  | { action: "planned"; month: string; id: string; planned_cents: number }
  | { action: "rename_category" | "rename_section"; month: string; id: string; name: string }
  | { action: "archive_category" | "archive_section"; id: string }
  | { action: "copy"; month: string; from_month: string }
  | { action: "reorder"; month: string; type: "section" | "category"; id: string; position: number }
  | { action: "manual"; description: string; merchant: string; original_date: string; amount_cents: number }
  | { action: "split"; id: string; allocations: AllocationInput[] }
  | { action: "date"; id: string; date: string | null }
  | { action: "exclude"; id: string; excluded: boolean };
export type Filters = {
  search: string; uncategorized: boolean; excluded: "hide" | "include" | "only";
  category: string | null; offset: number;
  sort: "date_desc" | "date_asc" | "amount_asc" | "amount_desc";
};
export const previewSchema = z.object({
  repeated: z.boolean(), duplicates: z.array(z.object({ row: z.number(), exact: z.boolean() })),
});
export type ImportPreview = z.infer<typeof previewSchema>;
export interface BudgetRepository {
  month(month: string): Promise<MonthData>;
  page(month: string, filters: Filters): Promise<z.infer<typeof pageSchema>>;
  mutate(command: Command): Promise<void>;
  suggest(transaction: Transaction, data: MonthData): Promise<ReturnType<typeof recommend>>;
  preview(fingerprint: string, rows: SourceInput[]): Promise<ImportPreview>;
  import(fingerprint: string, rows: SourceInput[]): Promise<void>;
  demo(month: string): Promise<void>;
}
export function makeClient(url: string, key: string) {
  if (!url || !key || key.startsWith("sb_secret_")) throw new Error("Configure a Supabase URL and publishable/anon key. Secret keys must never be used in the client.");
  return createClient<Database>(url, key);
}
export class SupabaseRepository implements BudgetRepository {
  constructor(readonly client: SupabaseClient<Database>) {}
  async month(month: string) {
    const { data, error } = await this.client.rpc("app_month", { p_month: month });
    if (error) throw new Error(error.message);
    return monthSchema.parse(data);
  }
  async page(month: string, f: Filters) {
    const { data, error } = await this.client.rpc("app_page", {
      p_month: month, p_search: f.search, p_uncategorized: f.uncategorized,
      p_excluded: f.excluded, p_category: f.category ?? undefined, p_offset: f.offset, p_sort: f.sort,
    });
    if (error) throw new Error(error.message);
    return pageSchema.parse(data);
  }
  async mutate(command: Command) {
    const { action, ...payload } = command;
    if (action === "manual") sourceInputSchema.parse(payload);
    const { error } = await this.client.rpc("app_mutate", { p_action: action, p_payload: payload });
    if (error) throw new Error(error.message);
  }
  async saveSplit(transaction: Transaction, allocations: AllocationInput[]) {
    validateSplit(transaction.amount_cents, allocations);
    await this.mutate({ action: "split", id: transaction.id, allocations });
  }
  async suggest(transaction: Transaction, data: MonthData) {
    const { data: history, error } = await this.client.rpc("app_history", { p_id: transaction.id });
    if (error) throw new Error(error.message);
    return recommend(transaction, z.array(transactionSchema).parse(history), data.categories.filter(c =>
      !data.sections.find(s => s.id === c.section_id)?.archived));
  }
  async preview(fingerprint: string, rows: SourceInput[]) {
    const { data, error } = await this.client.rpc("app_import_preview", { p_fingerprint: fingerprint, p_rows: rows });
    if (error) throw new Error(error.message);
    return previewSchema.parse(data);
  }
  async import(fingerprint: string, rows: SourceInput[]) {
    rows.forEach(row => sourceInputSchema.parse(row));
    const { error } = await this.client.rpc("app_mutate", {
      p_action: "import", p_payload: { fingerprint, rows: rows.map((row, i) => ({ ...row, row_number: i + 1 })) },
    });
    if (error) throw new Error(error.message);
  }
  async demo(month: string) {
    const { error } = await this.client.rpc("app_demo", { p_month: month });
    if (error) throw new Error(error.message);
  }
}
