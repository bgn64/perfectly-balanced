import { sum, type Detail, type Transaction } from "@balanced/domain";

export type ActivityRow = { transaction: Transaction; value: number };

export function groupActivity(details: Detail[]): ActivityRow[] {
  const rows = new Map<string, ActivityRow>();
  for (const detail of details) {
    const row = rows.get(detail.transaction.id);
    if (row) row.value = sum([row.value, detail.value]);
    else rows.set(detail.transaction.id, { transaction: detail.transaction, value: detail.value });
  }
  return [...rows.values()].sort((a, b) =>
    b.transaction.effective_date.localeCompare(a.transaction.effective_date) ||
    a.transaction.id.localeCompare(b.transaction.id));
}

export function categoryRows(transactions: Transaction[], categoryId: string, income: boolean): ActivityRow[] {
  return transactions.map(transaction => ({
    transaction,
    value: sum(transaction.allocations.filter(a => a.category_id === categoryId).map(a => a.amount_cents)) * (income ? 1 : -1),
  }));
}
