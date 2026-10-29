import { z } from "zod";
import { bankingSchema, monthSchema, pageSchema, suggestionSchema, type Transaction, type MonthData, type SourceInput, type AllocationInput, type BankRequest } from "@balanced/domain";
import { previewSchema, type BudgetRepository, type Command, type Filters } from "./contracts";

export class HttpRepository implements BudgetRepository {
  async request(body: unknown): Promise<unknown> {
    const response = await fetch("/api/budget", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      if (response.status === 401) window.location.reload();
      const error = z.object({ error: z.string() }).safeParse(payload);
      throw new Error(error.success ? error.data.error : "The request failed. Please retry.");
    }
    return payload;
  }
  async month(month: string) { return monthSchema.parse(await this.request({ operation: "month", month })); }
  async page(month: string, filters: Filters) { return pageSchema.parse(await this.request({ operation: "page", month, filters })); }
  async mutate(command: Command) { await this.request({ operation: "mutate", command }); }
  async suggest(transaction: Transaction, data: MonthData) {
    return suggestionSchema.nullable().parse(await this.request({ operation: "suggest", id: transaction.id, month: data.transactions.find(t => t.id === transaction.id)?.effective_date.slice(0, 7) ?? transaction.effective_date.slice(0, 7) }));
  }
  async preview(fingerprint: string, rows: SourceInput[]) { return previewSchema.parse(await this.request({ operation: "preview", fingerprint, rows })); }
  async import(fingerprint: string, rows: SourceInput[]) { await this.request({ operation: "import", fingerprint, rows }); }
  async demo(month: string) { await this.request({ operation: "demo", month }); }
  async banking(offset = 0) { return bankingSchema.parse(await this.request({ operation: "banking", offset })); }
  async bank(request: BankRequest) { return this.request({ operation: "bank", request }); }
  async resolveBank(id: string, version: number, decision: string, transaction?: string, allocations?: AllocationInput[], revision?: number) {
    await this.request({ operation: "resolve", id, version, decision, transaction, allocations, revision });
  }
  async restoreBankTransaction(id: string, revision: number) { await this.request({ operation: "restore", id, revision }); }
  async saveSplit(transaction: Transaction, allocations: AllocationInput[]) { await this.mutate({ action: "split", id: transaction.id, allocations }); }
  async signOut() {
    const response = await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error("Sign-out failed. Please retry.");
  }
}
