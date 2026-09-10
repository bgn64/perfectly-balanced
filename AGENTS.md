# Working on perfectly-balanced

perfectly-balanced is an invite-only, keyboard-first personal finance app built
with Vite, React, TypeScript, Supabase, and Plaid. The UI uses a Tokyo Night
terminal visual system and is designed mockup-first.

## Always

- Use Node.js 22 and npm. Keep changes compatible with the versions pinned in
  `package.json` and `package-lock.json`.
- Validate every change with `npm test`, `npm run lint`, `npm run build`, and
  `git diff --check`. Add focused Vitest coverage for changed domain behavior.
- Work on a focused branch named `bgn64/<topic>` from the latest `origin/main`.
- Ask before committing or pushing unless the user explicitly requested a
  commit, pull request, or full delivery. Add the trailer
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Preserve unrelated worktree changes. Never rewrite or discard user changes.

## Local development

- `npm run dev` starts or reuses the Docker-backed local Supabase stack,
  generates `.env.development.local`, and serves the app at
  `http://localhost:5173`.
- The seeded local account is `dev@example.test` with password
  `local-dev-password`. It exercises real Auth, JWT, RLS, and RPC behavior.
- Use `npm run local:reset` after migrations or seed changes and
  `npm run local:down` when local services are no longer needed.
- Never point local demo mode at a hosted Supabase project. Never place a
  service-role key, Plaid credential, access token, or other secret in a
  `VITE_*` value.

## User-facing UI

- Load `.github/skills/mockup-contract/SKILL.md` before every visible UI change.
  Its reconciliation, approval, and separate-commit gates are mandatory.
- Canonical mockups live under `mockup/surfaces/<surface>/`; the catalog is
  `mockup/index.html`. Existing top-level mockup pages are legacy references and
  migrate only when their surface is touched.
- Load `.github/skills/tokyo-terminal-design-system/SKILL.md` when changing UI,
  themes, layout, keyboard navigation, focus behavior, or mockups.
- Verify the running application with UI automation at the approved viewports,
  in both themes, and with mouse and keyboard. Check focus restoration,
  overflow, fixed geometry, and browser console errors.

## Backend and financial safety

- Get explicit permission before writing migrations, RPCs, RLS policies, Edge
  Functions, seed behavior, or Plaid integration changes.
- Add a new timestamped migration; never edit a migration that may have been
  deployed. Validate backend changes with a clean local reset.
- Keep Plaid access tokens in Supabase Vault and server-side code. The browser
  must never receive or log them. Do not introduce the paid Transactions
  Refresh endpoint without explicit product approval.
- Load `.github/skills/finance-domain/SKILL.md` for budgets, transactions,
  categories, splits, reports, recommendations, dates, or money calculations.
- Load `.github/skills/plaid-supabase-safety/SKILL.md` for migrations, RLS,
  security-definer functions, Edge Functions, webhooks, sync, Vault, or Plaid.