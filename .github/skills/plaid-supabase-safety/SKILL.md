---
name: plaid-supabase-safety
description: >-
  Security workflow for Supabase migrations, RLS, RPCs, Edge Functions, Auth,
  Plaid Items, webhooks, transaction sync, Vault, and production deployment.
  Use before planning or implementing any backend or Plaid change.
---

# Plaid and Supabase safety

Get explicit user permission before writing backend behavior. State the exact
migrations, RPCs, policies, functions, Auth settings, or Plaid calls involved.

## Trust boundaries

- Browser code uses the browser-safe anonymous/publishable key and a user JWT.
  It must never receive a service-role key, Plaid secret, Item access token,
  Vault value, sync cursor, or webhook secret.
- Plaid access tokens remain encrypted in Supabase Vault. Decrypt only inside
  the narrow server-side routine that needs the token for a Plaid request.
- Plaid configuration is production-only and requires HTTPS redirect/webhook
  URLs without query strings or fragments.
- Preserve the cursor-based `/transactions/sync` flow and its retry for
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`.
- Do not add the paid Transactions Refresh endpoint without explicit product
  approval.
- Keep imported data within the documented minimized transaction fields. Do
  not retain balances, account/routing numbers, identity, location, or raw bank
  payloads without explicit approval.

## Database changes

- Add a new timestamped migration. Never alter deployed history.
- RLS must deny cross-user access by default. Test owner, unauthorized, and
  missing-session behavior.
- Security-definer RPCs set a constrained `search_path`, validate `auth.uid()`,
  check ownership, and expose minimum grants.
- Preserve expected-state parameters used to prevent stale recommendations or
  concurrent edits from silently overwriting current data.

## Edge Functions and webhooks

- Reuse shared CORS, HTTP, Supabase, Plaid, and transaction-sync helpers.
- Keep `verify_jwt` explicit. Authenticated browser functions require a valid
  user JWT; provider webhooks use the provider trust boundary rather than a
  browser session.
- Log safe identifiers and error codes only. Never log tokens, secrets, full
  provider responses, or sensitive transaction payloads.

## Validation

Run `npm run local:reset`, focused Vitest tests, `npm run lint`, and
`npm run build`. Exercise authorized and unauthorized calls locally. Inspect
the final migration/function diff for grants, RLS, JWT settings, and secrets
before commit and again before deployment.