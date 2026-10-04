import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  monthSchema, pageSchema, transactionSchema, sourceInputSchema, validateSplit,
  recommend, type MonthData, type Transaction, type AllocationInput, type SourceInput,
} from "@balanced/domain";
import type { Database } from "./database.types";
import { bankingSchema, bankRequestSchema, type BankRequest, type AllocationInput as BankAllocation } from "@balanced/domain";

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
  async banking(offset = 0) {
    const { data, error } = await this.client.rpc("app_banking", { p_offset: offset });
    if (error) throw new Error(error.message);
    return bankingSchema.parse(data);
  }
  async restoreBankTransaction(id: string, revision: number) {
    const { error } = await this.client.rpc("app_bank_restore", { p_id: id, p_revision: revision });
    if (error) throw new Error(error.message);
  }
  async bank(request: BankRequest): Promise<unknown> {
    bankRequestSchema.parse(request);
    const { data, error } = await this.client.functions.invoke("plaid-api", { body: request });
    if (error) {
      const messages: Record<string, string> = {
        AUTHENTICATION_REQUIRED: "Sign in to manage connections.", SESSION_EXPIRED: "Your session expired. Sign in again.",
        DATABASE_OPERATION_FAILED: "This connection could not be updated. Refresh the page and try again.",
        ITEM_LOGIN_REQUIRED: "Your bank needs authorization again. Use Reconnect.",
        ACCOUNT_SELECTION_INVALID: "Select accounts currently available at this bank.",
        ITEM_CLEANUP_REQUIRED: "Bank authorization could not be completed. Contact the app administrator before connecting again.",
        BACKEND_CONFIGURATION_MISSING: "Bank connections are not available yet. Contact the app administrator.",
        UNSAFE_ENVIRONMENT: "Bank connections are temporarily unavailable. Contact the app administrator.",
        INVALID_REDIRECT_URI: "Bank authorization is temporarily unavailable. Contact the app administrator.",
        INVALID_WEBHOOK_URL: "Bank connections are temporarily unavailable. Contact the app administrator.",
        RATE_LIMITED: "Too many connection requests. Wait a moment before trying again.",
        ITEM_STILL_NEEDS_REPAIR: "Your bank still needs authorization. Please reconnect and complete all sign-in steps.",
        INSTITUTION_DOWN: "Your bank is temporarily unavailable. Please try again later.",
        INSTITUTION_NOT_RESPONDING: "Your bank isn't responding right now. Please try again later.",
      };
      if ("context" in error && error.context instanceof Response) {
        const payload: unknown = await error.context.json();
        const parsed = z.object({ error: z.string() }).safeParse(payload);
        if (parsed.success) throw new Error(messages[parsed.data.error] ?? `We couldn't complete this bank request. Please try again later. Reference: ${parsed.data.error}.`);
      }
      throw new Error("Cannot reach the bank-connection backend. Check your connection and retry.");
    }
    return data;
  }
  async resolveBank(id: string, version: number, decision: string, transaction?: string, allocations?: BankAllocation[], revision?: number) {
    const { error } = await this.client.rpc("app_bank_resolve", {
      p_id: id, p_version: version, p_decision: decision, p_transaction: transaction, p_allocations: allocations, p_revision: revision,
    });
    if (error) throw new Error(error.message);
  }
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
