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
- Plaid is deliberately not part of this implementation. Imported Plaid history
  is frozen history, not a live connection. Do not reintroduce legacy features
  merely to achieve feature parity.
