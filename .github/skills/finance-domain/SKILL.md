---
name: finance-domain
description: >-
  Financial domain rules for budgets, transactions, categories, splits,
  reports, recommendations, money, and calendar/month behavior. Use when
  changing finance models, calculations, labels, queries, RPCs, or tests.
---

# Finance domain

Keep financial behavior in pure, directly tested models where possible. Treat
database functions and UI summaries as views of the same domain rules, not
independent implementations.

## Existing invariants

- Budget direction is explicit: `spending` or `income`. Do not infer direction
  from a display color or label.
- Budget months use `YYYY-MM`. Shift months through the shared calendar helper
  rather than string or day arithmetic.
- `effective_transaction_date` is authoritative for month placement and
  reports. Preserve the imported date and optional user override separately.
- Calendar editing accepts strict `M/D/YYYY` input and stores ISO `YYYY-MM-DD`.
  Reject impossible dates rather than allowing JavaScript date rollover.
- User-entered budget values are nonnegative magnitudes with at most two
  decimal places. Direction is modeled separately.
- Use shared money formatters. Do not concatenate currency symbols or manually
  round displayed financial values.
- Transaction descriptions prefer merchant name, then transaction-name
  fallback, then `Transaction`.
- Ignored transactions, pending transactions, category assignments, splits,
  and recommendations have distinct semantics. Trace the owning model/RPC and
  preserve its optimistic-concurrency checks before changing totals.

## Change process

- Start at the owning model and its neighboring tests before touching React.
- Add focused tests for sign/direction, month boundaries, date overrides,
  ignored and pending behavior, split conservation, rounding, empty values,
  and recommendation conflicts relevant to the change.
- Keep report totals, budget actuals, transaction lists, and database RPCs
  consistent. If more than one layer computes the same rule, extract a shared
  pure model or explicitly test parity.
- For database-backed changes, also load
  `.github/skills/plaid-supabase-safety/SKILL.md` and get backend permission.