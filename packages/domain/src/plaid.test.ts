import { describe, expect, it } from "vitest";
import { normalizePlaidTransaction } from "./plaid";
const row = { transaction_id: "txn", account_id: "acct", pending_transaction_id: null, pending: false,
  date: "2026-10-03", amount: 19.99, iso_currency_code: "USD", name: "Store", merchant_name: null };
describe("Plaid normalization", () => {
  it("inverts provider signs into exact cents", () => {
    expect(normalizePlaidTransaction(row).amount_cents).toBe(-1999);
    expect(normalizePlaidTransaction({ ...row, amount: -0.29 }).amount_cents).toBe(29);
    expect(normalizePlaidTransaction({ ...row, amount: 0.29 }).amount_cents).toBe(-29);
  });
  it("fails explicitly for incompatible money and dates", () => {
    for (const amount of [0, 0.001, Number.NaN, 1_000_000_001]) {
      expect(() => normalizePlaidTransaction({ ...row, amount })).toThrow();
    }
    expect(() => normalizePlaidTransaction({ ...row, iso_currency_code: "CAD" })).toThrow(/UNSUPPORTED_CURRENCY/);
    expect(() => normalizePlaidTransaction({ ...row, date: "2026-02-30" })).toThrow();
  });
  it("preserves pending identity and uses a real description", () => {
    const normalized = normalizePlaidTransaction({ ...row, pending: true, pending_transaction_id: "pending", merchant_name: "Merchant" });
    expect(normalized.pending_transaction_id).toBe("pending");
    expect(normalized.description).toBe("Merchant");
    expect(normalized.pending).toBe(true);
    expect(() => normalizePlaidTransaction({ ...row, name: "" })).toThrow();
  });
});
