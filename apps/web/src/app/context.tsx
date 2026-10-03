import { createContext, useContext, useState, type ReactNode } from "react";
import type { Command, SupabaseRepository } from "@balanced/data";
import type { MonthData } from "@balanced/domain";

export type BudgetContextValue = {
  month: string; data: MonthData; repo: SupabaseRepository; uid: string;
  command: (command: Command) => Promise<void>; refresh: () => Promise<void>;
  notify: (message: string, important?: boolean) => void;
};
export const BudgetContext = createContext<BudgetContextValue | null>(null);
export function useBudget() {
  const context = useContext(BudgetContext);
  if (!context) throw new Error("Budget context unavailable.");
  return context;
}
export function errorMessage(e: unknown) { return e instanceof Error ? e.message : String(e); }
export function useOperation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(task: () => Promise<void>, success = "") {
    setPending(true); setError(""); setNotice("");
    try { await task(); setNotice(success); return true; }
    catch (e) { setError(errorMessage(e)); return false; }
    finally { setPending(false); }
  }
  const feedback: ReactNode = <>{error && <p role="alert" className="feedback error">{error}</p>}{notice && <p role="status" className="feedback success">{notice}</p>}</>;
  return { pending, run, feedback, error };
}
export function text(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== "string") throw new Error(`Missing ${key}.`);
  return value;
}
