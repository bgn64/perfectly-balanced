import type { BankReview, Banking } from "@balanced/domain";

export const connectionStatus: Record<Banking["connections"][number]["status"], string> = {
  select_accounts: "Choose accounts",
  syncing: "Updating transactions",
  active: "Connected",
  needs_reconnect: "Reconnect required",
  error: "Needs attention",
  disconnecting: "Disconnecting",
  disconnected: "Disconnected",
};
export const reviewReason: Record<BankReview["reason"], string> = {
  overlap: "Possible duplicate",
  amount: "Amount changed",
  removed: "Removed by bank",
  invalid: "Unable to import",
};
export function importStartDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function bankIssueMessage(code: string) {
  if (code === "UNSUPPORTED_CURRENCY") return "This transaction is not in US dollars and cannot be imported.";
  if (code === "INVALID_CENT_PRECISION") return "The bank reported an amount with fractions of a cent. It cannot be imported without changing the amount.";
  if (code === "ZERO_AMOUNT") return "This transaction has no monetary amount and has not been imported.";
  return "The bank supplied incomplete or unsupported transaction details. This activity has not been imported.";
}
export function bankDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
}
