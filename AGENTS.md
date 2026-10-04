# Working on Perfectly Balanced

- Use Node.js 24 and npm workspaces. The web app is in `apps/web`; shared domain
  and data contracts are in `packages`.
- Preserve existing user changes. Keep work on a focused branch and ask before
  committing, pushing, merging, or deploying.
- Validate changes with the relevant tests, `npm run lint`, `npm run build`, and
  `git diff --check`. Authentication/hosting changes also need
  `npm run test:hosting`; financial workflows need local Supabase integration
  and browser checks.
- Local development uses Docker-backed Supabase. Do not point tests or preview
  deployments at production financial data. Never reset an existing database
  to make a rehearsal easier.
- Production is private: signup is disabled server-side and in production UI.
  Local signup is intentional for local accounts and tests.
- Never place privileged credentials in `VITE_*`, source, logs, or deployment
  artifacts. Financial exports and SQL backups belong in private, gitignored
  directories, not the repository history.
- Do not edit previously deployed migrations. The legacy-to-new schema
  replacement is a separate, explicitly approved maintenance operation:
  verified backups, local replacement/rollback rehearsal, stopped legacy writers,
  provider disconnection, exact reconciliation, and preserved Auth identity are
  mandatory prerequisites.
- The production Actions workflow is manual and must not execute the one-time
  replacement implicitly. Native Vercel Git deployment stays disabled. Do not
  set `BUDGET_SCHEMA_READY=true` until production reconciliation succeeds.
- Plaid credentials and access tokens remain backend-only; access tokens use
  Supabase Vault. Local development uses Sandbox only, against local Supabase.
  Imported history has no assumed live account mapping. Preserve UUIDs, splits,
  exclusions and date overrides; ambiguous overlaps and financial conflicts
  need explicit review. Pending records stay outside financial totals.
- Plaid backend changes also require `npm run check:functions`,
  `npm run test:functions`, local database tests and browser checks. Production
  backend deployment/activation needs separate explicit approval; never restore
  disconnected legacy Items or restart legacy writers.
