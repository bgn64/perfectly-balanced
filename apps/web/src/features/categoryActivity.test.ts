import { describe, expect, it } from "vitest";
import { categoryActual, reports, sum, transactionSchema, type MonthData } from "@balanced/domain";
import { categoryRows, groupActivity } from "./categoryActivity";

const transaction = (id: string, excluded = false, removed = false) => transactionSchema.parse({
  id, description: "Same merchant", merchant: "Shop", amount_cents: -1000,
  original_date: "2026-10-01", effective_date: "2026-10-01", date_override: null,
  excluded, provider_removed: removed, source: "manual",
  allocations: [
    { id: `${id}-a`, category_id: "food", amount_cents: -1300 },
    { id: `${id}-b`, category_id: "food", amount_cents: 100 },
    { id: `${id}-c`, category_id: null, amount_cents: 300 },
    { id: `${id}-d`, category_id: null, amount_cents: -100 },
  ],
});
const data = (): MonthData => ({
  sections: [{ id: "living", name: "Living", kind: "spending", position: 1, archived: false }],
  categories: [{ id: "food", name: "Food", section_id: "living", archived: false }],
  budget_sections: [{ section_id: "living", name: "Living", position: 1 }],
  budget_categories: [{ category_id: "food", name: "Monthly food", planned_cents: 1500, position: 1 }],
  transactions: [transaction("first"), transaction("second"), transaction("excluded", true), transaction("removed", false, true)],
});

describe("category activity presentation", () => {
  it("groups by exact parent ID, not duplicate descriptions, and totals only matched allocations", () => {
    const bucket = reports(data(), "spending", false, true)[0].children[0];
    const rows = groupActivity(bucket.details);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.transaction.id)).toEqual(["first", "second"]);
    expect(rows.map(row => row.value)).toEqual([1200, 1200]);
    expect(sum(rows.map(row => row.value))).toBe(bucket.value);
    expect(rows[0].transaction.amount_cents).toBe(-1000);
  });
  it("keeps excluded/removed Budget records visible without including them in net totals", () => {
    const d = data();
    const rows = categoryRows(d.transactions, "food", false);
    expect(rows).toHaveLength(4);
    expect(rows.every(row => row.value === 1200)).toBe(true);
    expect(-categoryActual(d, "food")).toBe(2400);
    expect(reports(d, "spending", false, true)[0].children[0].details).toHaveLength(4);
  });
  it("preserves sign-specific uncategorized contributions in mixed-sign parents", () => {
    const d = data();
    const income = reports(d, "income", false, true).find(b => b.id === "uncategorized")!;
    const spending = reports(d, "spending", false, true).find(b => b.id === "uncategorized")!;
    expect(groupActivity(income.details).map(row => row.value)).toEqual([300, 300]);
    expect(groupActivity(spending.details).map(row => row.value)).toEqual([100, 100]);
    expect(reports(d, "income", false, false)).toEqual([]);
  });
  it("orders deterministically by effective date then identity and handles empty detail", () => {
    const d = data();
    d.transactions[1].effective_date = "2026-10-02";
    const rows = groupActivity(reports(d, "spending", false, true)[0].details);
    expect(rows.map(row => row.transaction.id)).toEqual(["second", "first"]);
    expect(groupActivity([])).toEqual([]);
  });
});
