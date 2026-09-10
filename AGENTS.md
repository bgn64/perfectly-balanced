# Working on perfectly-balanced

perfectly-balanced is an invite-only, keyboard-first personal finance app built
with Vite, React, TypeScript, Supabase, and Plaid. The UI uses a Tokyo Night
terminal visual system and is designed mockup-first.

## Always

- Use Node.js 22 and npm. Keep changes compatible with `package.json` and
  `package-lock.json`.
- Before delivery, run `npm test`, `npm run lint`, `npm run build`, and
  `git diff --check`.
- Work on a focused branch named `bgn64/<topic>` from the latest `origin/main`.
- Ask before committing or pushing unless the user explicitly requested a
  commit, pull request, or full delivery. Add the trailer
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

## Local development

- `npm run dev` starts or reuses the Docker-backed local Supabase stack,
  generates `.env.development.local`, and serves the app at
  `http://localhost:5173`.
- The seeded local account is `dev@example.test` with password
  `local-dev-password`. It exercises real Auth, JWT, RLS, and RPC behavior.
- Use `npm run local:reset` after migrations or seed changes and
  `npm run local:down` when local services are no longer needed.
- Run mockups with `npm run mockup`; to serve them beside the app, use
  `npm run mockup -- --port 4174 --strictPort`.

## User-facing UI

- Load `.github/skills/mockup-contract/SKILL.md` before every visible UI change.
  Its reconciliation, approval, and separate-commit gates are mandatory.
- Canonical mockups live under `mockup/surfaces/<surface>/`; the catalog is
  `mockup/index.html`. Existing top-level mockup pages are legacy references and
  migrate only when their surface is touched.

## Backend changes

- Get explicit permission before writing migrations, RPCs, RLS policies, Edge
  Functions, seed behavior, or Plaid integration changes.
- Add a new timestamped migration; never edit a migration that may have been
  deployed. Validate backend changes with a clean local reset.
- Never put a Supabase service-role key, Plaid credential, access token, or
  other secret in a `VITE_*` value.