---
applyTo: "supabase/**"
description: "Safety and validation rules for Supabase migrations, RLS, RPCs, Edge Functions, Auth, seeds, Vault, and Plaid-backed data."
---

# Supabase instructions

- Get explicit user permission before writing migrations, RPCs, RLS policies,
  Edge Functions, Auth configuration, seed behavior, or Plaid integration.
- Add a new timestamped migration for schema behavior. Never edit a migration
  that may have run in a hosted environment.
- Treat RLS as part of the feature contract. Test authenticated ownership,
  unauthorized access, missing sessions, and friend/shared access where
  applicable.
- Every `security definer` function must set a constrained `search_path`,
  reject a missing `auth.uid()` when authentication is required, validate row
  ownership, and expose only the minimum grants needed by its caller.
- Keep browser and service-role clients separate. Never return, log, seed, or
  expose service-role keys, Plaid credentials, access tokens, Vault contents,
  or transaction data beyond the product's documented data-minimization scope.
- Reuse the shared Edge Function HTTP, CORS, Supabase, Plaid, and transaction
  sync helpers instead of creating parallel authentication or error behavior.
- Keep each function's `verify_jwt` setting explicit in `supabase/config.toml`.
  A webhook without Supabase JWT verification still needs its provider
  authenticity and ownership boundary preserved.
- Keep `supabase/seed.sql` deterministic and local-only. Do not add live Plaid
  Items, webhooks, Vault secrets, or bank data to fixtures.
- After backend changes run `npm run local:reset`, focused tests,
  `npm run lint`, and `npm run build`.