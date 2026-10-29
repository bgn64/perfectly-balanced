import { z } from "zod";
import { pageSchema, type MonthData, type Transaction, type AllocationInput, type SourceInput, recommend } from "@balanced/domain";

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
