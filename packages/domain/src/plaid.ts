import { z } from "zod";

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number(value.slice(0, 4)) > 0 && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Invalid calendar date");
const providerId = z.string().min(1).max(256);
export const bankAccountSchema = z.object({
  account_id: providerId, name: z.string().min(1).max(200), mask: z.string().nullable(),
  type: z.string(), subtype: z.string().nullable(), selected: z.boolean(),
});
export const providerTransactionSchema = z.object({
  transaction_id: providerId, account_id: providerId,
  pending_transaction_id: providerId.nullable(), pending: z.boolean(),
  original_date: calendarDate, amount_cents: z.number().int().min(-100_000_000_000).max(100_000_000_000).refine(v => v !== 0),
  description: z.string().trim().min(1).max(500), merchant: z.string().max(200),
});
export type ProviderTransaction = z.infer<typeof providerTransactionSchema>;
export class PlaidNormalizationError extends Error {
  readonly code: "UNSUPPORTED_CURRENCY" | "INVALID_CENT_PRECISION" | "ZERO_AMOUNT";
  constructor(code: PlaidNormalizationError["code"]) { super(code); this.code=code; }
}
export const rawTransactionSchema = z.object({
  transaction_id: providerId, account_id: providerId,
  pending_transaction_id: providerId.nullable(), pending: z.boolean(),
  date: calendarDate, amount: z.number().finite(), iso_currency_code: z.string().nullable(),
  name: z.string(), merchant_name: z.string().nullable(),
});
export function normalizePlaidTransaction(input: unknown): ProviderTransaction {
  const raw = rawTransactionSchema.parse(input);
  if (raw.iso_currency_code !== "USD") throw new PlaidNormalizationError("UNSUPPORTED_CURRENCY");
  if (raw.amount===0) throw new PlaidNormalizationError("ZERO_AMOUNT");
  const scaled = raw.amount * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 0.00001 || !Number.isSafeInteger(rounded)) {
    throw new PlaidNormalizationError("INVALID_CENT_PRECISION");
  }
  return providerTransactionSchema.parse({
    transaction_id: raw.transaction_id, account_id: raw.account_id,
    pending_transaction_id: raw.pending_transaction_id, pending: raw.pending,
    original_date: raw.date, amount_cents: -rounded,
    description: raw.merchant_name?.trim() || raw.name.trim(), merchant: raw.merchant_name ?? "",
  });
}
export const connectionSchema = z.object({
  id: z.string().uuid(), institution_name: z.string(), environment: z.enum(["sandbox", "production"]),
  status: z.enum(["select_accounts", "syncing", "active", "needs_reconnect", "error", "disconnecting", "disconnected"]),
  import_start: calendarDate, connected_at: z.string(), last_synced_at: z.string().nullable(),
  error_code: z.string().nullable(), accounts: z.array(bankAccountSchema),
  initial_complete: z.boolean(), historical_complete: z.boolean(),
});
export const bankReviewSchema = z.object({
  id: z.string().uuid(), connection_id: z.string().uuid(), version: z.number().int(),
  reason: z.enum(["overlap", "amount", "removed", "invalid"]),
  record: providerTransactionSchema.nullable(), error: z.string().nullable(),
  transaction_id: z.string().uuid().nullable(),
  candidates: z.array(z.object({
    id: z.string().uuid(), revision: z.number().int(), description: z.string(), original_date: calendarDate,
    amount_cents: z.number().int(), excluded: z.boolean(), date_override: calendarDate.nullable(),
    allocations: z.array(z.object({ category_id: z.string().nullable(), amount_cents: z.number().int() })),
  })),
});
export const bankingSchema = z.object({
  connections: z.array(connectionSchema), reviews: z.array(bankReviewSchema),
  pending: z.array(providerTransactionSchema.extend({ connection_id: z.string().uuid() })),
  review_total: z.number().int(), pending_total: z.number().int(),
});
export type Banking = z.infer<typeof bankingSchema>;
export type BankReview = z.infer<typeof bankReviewSchema>;
export const bankRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), import_start: calendarDate }),
  z.object({ action: z.literal("exchange"), intent_id: z.string().uuid(), public_token: z.string().min(1).max(2048) }),
  z.object({ action: z.literal("repair"), id: z.string().uuid() }),
  z.object({ action: z.literal("repaired"), id: z.string().uuid() }),
  z.object({ action: z.literal("disconnect"), id: z.string().uuid() }),
  z.object({ action: z.literal("sync"), id: z.string().uuid() }),
  z.object({ action: z.literal("accounts"), id: z.string().uuid(), accounts: z.array(providerId).min(1).max(100) }),
]);
export type BankRequest = z.infer<typeof bankRequestSchema>;
