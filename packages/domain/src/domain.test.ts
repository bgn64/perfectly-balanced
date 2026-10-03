import { describe, expect, it } from "vitest";
import { canPie, categoryActual, money, parseCsv, parseMoney, recommend, reports, validateSplit, type MonthData, type Transaction } from "./index";

const transaction = (amount: number, category: string | null): Transaction => ({
  id: `${amount}`, description: "Coffee shop", merchant: "Cafe", amount_cents: amount,
  original_date: "2026-10-01", effective_date: "2026-10-01", date_override: null,
  excluded: false, source: "manual", allocations: [{ id: `${amount}`, category_id: category, amount_cents: amount }],
});
const data = (): MonthData => ({
  sections: [{ id: "spend", name: "Living", kind: "spending", archived: false, position: 1 }, { id: "income", name: "Income", kind: "income", archived: false, position: 0 }],
  categories: [{ id: "food", name: "Food", section_id: "spend", archived: false }, { id: "salary", name: "Salary", section_id: "income", archived: false }],
  budget_sections: [{ section_id: "spend", name: "Living", position: 1 }, { section_id: "income", name: "Income", position: 0 }],
  budget_categories: [{ category_id: "food", name: "Food", planned_cents: 15000, position: 0 }, { category_id: "salary", name: "Salary", planned_cents: 300000, position: 0 }],
  transactions: [],
});
describe("exact money and splits", () => {
  it("parses cents without floating point rounding", () => {
    expect(parseMoney("-42.50")).toBe(-4250);
    expect(parseMoney("0.29")).toBe(29);
    expect(money(-0)).toBe("$0.00");
    expect(() => parseMoney("1.001")).toThrow();
    expect(() => parseMoney("Infinity")).toThrow();
  });
  it("permits exact mixed-sign splits and rejects other totals", () => {
    expect(() => validateSplit(-10000, [{ category_id: "food", amount_cents: -12000 }, { category_id: null, amount_cents: 2000 }])).not.toThrow();
    expect(() => validateSplit(-10000, [{ category_id: null, amount_cents: -9999 }])).toThrow();
    expect(() => validateSplit(0, [])).toThrow();
  });
});
describe("budget and reports", () => {
  it("nets refunds without double counting", () => {
    const d = data(); d.transactions = [transaction(-10000, "food"), transaction(2500, "food")];
    expect(reports(d, "spending", false, true)[0].value).toBe(7500);
    expect(categoryActual(d, "food")).toBe(-7500);
    expect(reports(d, "spending", true, true)[0].value).toBe(15000);
  });
  it("uses assignment before sign and falls back instead of taking absolute values", () => {
    const d = data(); d.transactions = [transaction(2000, "food"), transaction(-500, "salary")];
    const spend = reports(d, "spending", false, true);
    expect(spend[0].value).toBe(-2000); expect(canPie(spend)).toBe(false);
    expect(reports(d, "income", false, true)[0].value).toBe(-500);
  });
  it("toggles only unassigned allocations and excludes the entire parent", () => {
    const d = data(); const t = transaction(-10000, "food");
    t.allocations = [{ id: "a", category_id: "food", amount_cents: -12000 }, { id: "b", category_id: null, amount_cents: 2000 }];
    d.transactions = [t];
    expect(reports(d, "spending", false, false)[0].value).toBe(12000);
    expect(reports(d, "income", false, true)[0].value).toBe(2000);
    expect(reports(d, "income", false, false)).toEqual([]);
    t.excluded = true; expect(reports(d, "spending", false, true)).toEqual([]);
  });
  it("preserves unplanned category drill-down and empty states", () => {
    const d = data(); d.budget_categories = []; d.transactions = [transaction(-50, "food")];
    const result = reports(d, "spending", false, true);
    expect(result[0].name).toBe("Unplanned");
    expect(result[0].children[0].details[0].value).toBe(50);
    expect(canPie([])).toBe(false);
  });
});
describe("ingestion and recommendations", () => {
  it("validates dates, amounts and duplicate identifiers", () => {
    expect(parseCsv("date,description,amount\n2026-02-30,Shop,-1.00").errors).not.toEqual([]);
    expect(parseCsv("date,description,amount\n2026-10-01,Shop,-1.00").rows[0].amount_cents).toBe(-100);
    expect(parseCsv("date,description,amount,external_id\n2026-10-01,A,-1,x\n2026-10-01,A,-1,x").errors).not.toEqual([]);
  });
  it("learns from history, ignoring excluded, archived and ambiguous splits", () => {
    const d = data(); const t = transaction(-100, "food");
    expect(recommend(t, [t], d.categories)?.category_id).toBe("food");
    t.excluded = true; expect(recommend(t, [t], d.categories)).toBeNull();
    t.excluded = false; t.allocations.push({ id: "b", category_id: "salary", amount_cents: 50 });
    expect(recommend(t, [t], d.categories)).toBeNull();
  });
});
