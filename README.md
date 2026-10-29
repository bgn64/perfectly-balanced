# Perfectly Balanced

A private personal budgeting app: monthly plans, split transaction
categorization, CSV import, reports, and optional outbound Plaid synchronization.

The container cutover uses **Next.js, Better Auth, SQLite, and Node.js 24** in
one Docker Compose service. It does not need Supabase, Vercel, an SMTP server,
or a public webhook endpoint. Existing financial screens and draft-navigation
guards are retained inside a server-authenticated Next.js shell.

## Local container

Install/start Docker Desktop with Linux containers. From PowerShell:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put that random value in `BETTER_AUTH_SECRET` in `.env`. Leave Plaid disabled
initially. Keep `BETTER_AUTH_URL=http://localhost:3000` and visit exactly that
origin, not a different hostname.

```powershell
docker compose up --build -d
docker compose ps
docker compose exec app npm run account:create
```

Account creation is interactive; passwords are hidden, never command arguments.
For imported data, use the **original financial owner UUID** when prompted.
Otherwise leave it blank. There is no default user and public signup is disabled
on the server. Open <http://localhost:3000>.

```powershell
docker compose exec app npm run account:reset
docker compose logs --tail 80 app
docker compose stop
docker compose start
```

Stopping/restarting preserves the named volume. **Do not use
`docker compose down -v` on data you want to keep.** No database resets or demo
loads run automatically. Schema upgrades are repeatable and startup fails if
migration fails. Keep verified backups before image upgrades.

See [the cutover guide](docs/container-cutover.md) for Supabase export/import,
exact reconciliation, local rehearsal, Caddy, server deployment and rollback.

## Development and validation

Use Node.js 24 and npm workspaces. Copy the root environment example, set its
secret, then:

```powershell
npm ci
npm run db:migrate
npm run account:create
npm run dev
```

For active Plaid development, prefer the container so its worker also runs.
The host `dev` command starts Next.js only. No tests may use production
financial data or production Plaid credentials.

```powershell
npm test
npm run lint
npm run build
npx playwright install chromium
npm run test:hosting
git diff --check
docker compose build
```

`test:hosting` starts an isolated temporary SQLite database, provisions a
fictional account, and exercises the production application in Chromium.
`test:container` tests SQLite financial invariants, local auth, polling,
encryption, reconciliation and backup parsing. `check:functions`,
`test:functions`, and `test:db` now validate the Node/SQLite implementation;
their old Deno/pgTAP equivalents are explicitly `legacy:*` scripts.
Historical hosted integration tests and migrations remain reference material,
not the default test target. Hosted deployment Actions are disabled.

## Financial guarantees

- USD only, exact signed integer cents: positive received, negative paid.
- Income/spending classification follows the category's permanent section.
  Reports show signed net activity, not gross absolute amounts.
- Splits may mix signs but sum exactly to their parent; parents are never
  added again on top of splits.
- Exclusions remove the complete parent and all allocations from totals and
  recommendation history. Original dates are retained when overrides change.
- Monthly names, amounts, ordering and membership are snapshots. Copying is
  explicit and does not carry transactions or balances. Archiving retains
  history; the Income section is permanent.
- CSV imports validate before writing, commit atomically, and retain source
  IDs/fingerprints for duplicate protection.
- Pending Plaid records stay outside financial totals. Ambiguous overlapping
  history, split/amount conflicts and removals require explicit review.
- Every private API checks a server-side session and ownership. SQLite is local
  storage, not a network-accessible database endpoint.

## Layout

- `apps/web`: Next.js routing/authenticated shell, existing React financial UI,
  server-only SQLite/auth/Plaid services.
- `packages/domain`: shared exact-money, budgeting, CSV, reporting and Plaid
  contracts.
- `packages/data`: browser HTTP adapter and historical Supabase adapter.
- `scripts/container`: migration, interactive accounts, import, backup, worker,
  health and process supervision.
- `tests/container`, `tests/hosting`: isolated backend and browser validation.
- `supabase`: immutable historical migrations/functions/tests; not deployed by
  this container.

Financial dumps, SQLite files, populated environment files and encryption keys
are private, gitignored, and excluded from image build context. Never put secrets
in `VITE_*`, `NEXT_PUBLIC_*`, logs, source control or an image build argument.
