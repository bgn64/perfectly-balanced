# Perfectly Balanced

A budgeting web app with monthly budgets, efficient transaction categorization,
and drill-down income/spending reports. USD only. Live Plaid is intentionally
deferred; no bank credentials are required.

## Requirements

- Node.js 24 LTS and npm.
- Docker Engine running and accessible to your user (`docker info`).
- Git and curl are useful for setup. Supabase CLI is a project dependency.

## Run locally

From this directory:

```bash
npm ci
npm run backend:start
```

The initial start downloads Supabase Docker images. Local services:

| Service | Address |
| --- | --- |
| API | http://127.0.0.1:54321 |
| Studio | http://127.0.0.1:54323 |
| Mailpit (development email) | http://127.0.0.1:54324 |
| Postgres | localhost:54322 |

Copy `.env.example` to `apps/web/.env.local`. Set the API URL and the local
**publishable/anon** key printed by `npx supabase status`. Never use the secret
or service-role key in the browser. The environment file is gitignored.

```bash
npm run dev
```

Open http://127.0.0.1:5173 and create an account with a password of at least eight
characters. Local email confirmation is disabled. Password-reset emails appear
in Mailpit; follow the recovery link to set a new password. Redirects are
configured for `127.0.0.1:5173`, so use that host rather than `localhost`.

For a guided example, open **Budget actions** and select **Load demo data** in an
empty month. Demo records are clearly labeled, belong only to the signed-in
user, and can be loaded once per month. Otherwise create your own budget and
use **Add transaction** or **Import CSV** in Transactions. No demo users or credentials
are shipped.

Use `npm run backend:stop` to stop local Supabase. Docker-backed data persists
between ordinary stops/starts. **`npm run backend:reset` destroys the project's
local database and reapplies migrations; do not run it against data you need.**
After adding migrations to an existing local instance, use:

```bash
npx supabase migration up --local
npm run types
```

## Financial semantics

- Positive means money received; negative means money paid. Integer cents are
  used throughout, with exact input parsing and explicit supported ranges.
- A category's section determines income versus spending, even for unusual
  signs. Uncategorized allocations use their own sign.
- Income is the signed sum in the permanent Income section. Spending is the
  negative of the signed spending sum, so a $100 charge and $25 refund produce
  $75 net spending, not $125 gross activity.
- Planned amounts are nonnegative. Spending remaining is planned minus net
  spent; income still expected is planned minus received.
- Splits may mix signs, but must sum exactly to the parent amount. Unassigned
  remainders are explicit allocations. Parents are never added on top of splits.
- **Exclude from budget & reports** removes the entire parent and all splits
  from balances, reports, and recommendation history. It is reversible through
  the excluded-transaction filter, not deletion.
- Effective dates determine the selected calendar month; original dates remain
  intact. Splits share the parent's effective date and exclusion state.
- A date move into a month without the assigned category preserves assignment
  and displays unplanned activity at zero planned dollars. Add the existing
  category to that month explicitly if desired.
- Each month has its own planned amounts, membership, ordering, and name
  snapshots. Copying is explicit, requires an empty destination, and carries no
  transactions or remaining balances. Archived catalog entries are not copied.
- Renames change the selected monthly snapshot and the catalog for future use,
  not other existing monthly snapshots. Category parent sections and section
  income/spending classification are immutable to preserve historical meaning.
- Remove a monthly category only after reassigning all its transactions for
  that month, including excluded ones. Clicking its name opens the relevant
  transaction filter. Sections must be emptied before monthly removal. Archiving
  catalog entries preserves history but hides them from new assignments.
- Charts retain signed net values. Negative buckets use a signed list with the
  same drill-down controls rather than taking absolute values. Empty or
  all-zero totals have an empty state. Every chart has keyboard-operable textual
  alternatives. Zero-valued buckets stay in the breakdown, not pie wedges.
- Actual reports can omit uncategorized allocations without omitting assigned
  portions of split transactions. Planned reports show only planned amounts.
- There is one Income section, so its section-level pie is normally one slice
  (plus uncategorized income, if enabled); drill into it to see income categories.

## Transactions and import

Search description/merchant, filter by category or uncategorized remainder,
include/hide/show only excluded records, sort, and paginate. Recommendations
learn from prior nonexcluded categorizations across months using normalized
merchant/payee first, then description; frequency and recency break ties.
Ambiguous mixed-category histories are not learned. Suggestions explain their
match and never assign anything automatically. Split suggestions target one
allocation.

CSV format:

```csv
date,description,amount,merchant,external_id
2026-10-01,Salary,4200.00,Employer,payroll-1
2026-10-02,Weekly groceries,-82.34,Market,purchase-1
```

`date`, `description`, and signed `amount` are required. `merchant` and
`external_id` are optional. Use `YYYY-MM-DD` dates and at most two decimal
places; currency is USD. Maximum 1,000 rows and 2 MB per file.

The preview validates all rows before writing. An identical file is blocked.
External IDs are unique per user/CSV source and block duplicate imports
atomically. Without IDs, file fingerprint plus row identity preserves genuinely
identical purchases within a file. Similar purchases in different files are
flagged for explicit review, not silently deduplicated. Keep stable external
IDs when importing overlapping exports. Any commit failure rolls back the
entire batch.

## Architecture

- `apps/web`: React/Vite, React Router, TanStack Query, accessible forms and
  Recharts with textual drill-down alternatives.
- `packages/domain`: framework-independent exact-money parsing, allocation
  validation, budgeting/reporting, CSV input contracts, and recommendations.
- `packages/data`: typed repository interface and Supabase adapter. Database
  types are generated using `npm run types`; JSON responses are schema-validated.
- `supabase/migrations`: tables, RLS, transactional authenticated RPCs, fixed
  Income protection, and deferred exact-allocation constraints.
- `tests`: real Supabase integration, pgTAP invariants, and browser workflows.

Clients share domain contracts without depending on React. Authenticated table
reads are protected by per-user RLS; table writes are not granted to clients.
Mutations go through owner-scoped, transactional database functions. Composite
foreign keys prevent cross-user references. User operations are serialized per
owner to protect copies and imports. Errors are shown with user input retained
for retry, and relevant cached reads are invalidated after successful writes.

The source ingestion contract is separate from user-owned category assignments,
exclusions, and date overrides. A future Plaid adapter should normalize provider
records to this contract, storing secrets/tokens and executing calls/webhooks on
a trusted backend. Provider updates must preserve user edits. Pending-to-posted
reconciliation, removed transactions, and sync cursors remain explicit future
work; this version does not pretend to synchronize bank data.

Local development uses real Supabase, not browser-only/mock persistence. It is
not offline-first. Shared households, multi-currency,
rollover, multi-month reports, custom rules, and alternate clients are deferred.
The Supabase configuration is for local development. Hosted authentication and
the legacy cutover require the production configuration below.

## Private production hosting

The existing deployment uses GitHub repository `bgn64/perfectly-balanced`,
Supabase project `hqeoxulnpkksxvoyxlvq`, and
https://perfectly-balanced.vercel.app/. No second hosted backend is required.

- Vercel's root directory is the repository root. `vercel.json` installs the
  npm workspaces, runs the root build, and serves `apps/web/dist`. Its filesystem
  handler serves real assets before the SPA fallback handles deep links.
- Native Vercel Git deployment is disabled by configuration. Verify that it is
  also gated in the existing project before pushing replacement code; the old
  deployment does not have this configuration.
- The replacement Actions production workflow is **manual only** and performs
  no database migration or Edge Function deployment. It requires `main`, the
  confirmation `deploy`, and the Production environment variable
  `BUDGET_SCHEMA_READY=true`. Set that variable only after the cutover and
  reconciliation pass. The legacy workflow must stay disabled during preparation.
- Retain `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and the `VERCEL_TOKEN` secret in
  GitHub. CI uses Node 24. Configure only the hosted project's browser-safe
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for the production build.
  Never expose privileged keys through `VITE_*`.
- Production builds offer sign-in and recovery but **no signup**. Local Vite
  development retains signup for local accounts and tests. Disable hosted
  signup in Supabase too: hiding the UI is not an authorization boundary.
- Preserve the existing Auth user and UUID. Set Supabase's Site URL and recovery
  redirect allowlist to the canonical HTTPS production URL. Do not push local
  auth configuration to production.
- Test recovery email delivery. Supabase's built-in email service only supports
  organization-team recipients and has tight limits; use custom SMTP if delivery
  is blocked. Email/password login does not itself require sending email.
- Do not point preview builds or local test suites at production financial data.

## Legacy data cutover tooling

`npm run cutover` provides administrator-only export, preparation, and local
verification. It **never applies production SQL**. It uses saved Supabase CLI
authentication and the fixed production project reference for read-only export.

```bash
npm run cutover -- export backups/rehearsal/legacy.json
npm run cutover -- prepare backups/rehearsal/legacy.json backups/rehearsal/prepared
npm run cutover:rehearse -- backups/rehearsal/legacy.json
# After importing into an isolated local Supabase rehearsal instance:
npm run cutover -- verify-local backups/rehearsal/legacy.json
```

New export directories are private (0700); files are created exclusively with
0600 permissions. Existing output files are never overwritten. Backups are
gitignored and must not be uploaded, committed, or included in deployment
artifacts. Copy verified backups to private secure storage. The financial export
is **not a complete database backup**: rollback additionally needs legacy schema,
RPCs/grants, migration history, and the appropriate Auth/configuration inventory.
Provider token handling and any Vault-dependent restoration require separate care.

`cutover:rehearse` creates a separate, uniquely named database in the existing
local Supabase Postgres container without resetting or replacing its `postgres`
database. It applies the new migrations to a minimal Auth scaffold, imports the
snapshot, verifies every row and field, tests cross-owner RLS and rerun rejection,
and retains a private verification manifest. It refuses to overwrite a previous
rehearsal. This validates the new schema/import, not legacy replacement or full
rollback; those remain separate approval prerequisites.

Run `npm run test:hosting` to test the production build's private authentication,
recovery messaging, and route refreshes locally. These browser tests send no
production writes; the recovery request is intercepted.

Preparation preserves category IDs, monthly planned amounts, transaction IDs,
exact signed cents, original dates/overrides, exclusions, source IDs, and
user-applied splits. It adds explicit uncategorized remainders. Income is
consolidated into Income; root spending and unplaced categories go to General.
Categories absent from a monthly budget do not acquire invented planned amounts.
Empty spending subsections remain monthly snapshots. Pending status and account
metadata remain in the private source archive; imported pending records are
ordinary transactions because this app does not synchronize banks.

Incompatible currencies, amounts, descriptions, references, ownership, or
cross-month section/direction changes fail preparation explicitly. Nothing is
silently omitted. The private plan includes exact financial reconciliation totals;
local verification compares every imported row/field and the cutover fingerprint.
The SQL import requires the existing auth user and an empty destination for that
user, runs in one transaction, and checks the allocation constraints before commit.

**Do not run `supabase db push` against the legacy production schema.** Its table
names collide with this implementation. An explicitly approved maintenance
operation must freeze writes, take a final verified backup, disconnect all Plaid
Items, retire legacy ingestion, replace only allowlisted app objects while
preserving Auth/managed schemas, import and reconcile, and establish the new
migration ledger before releasing the frontend. Rehearse replacement and rollback
locally first; never reset the user's existing local database for rehearsal.
Disconnecting Plaid cannot be undone by restoring a database; reconnection needs
new bank authorization.

The replacement rehearsal also needs private `legacy-schema.sql` and
`legacy-data.sql` dumps scoped to `public,supabase_migrations`. With those in the
snapshot directory, run:

```bash
npm run cutover:rehearse-replacement -- backups/rehearsal
```

This restores the actual legacy backup into another isolated local database,
simulates disconnection there, tests an injected replacement failure, applies
the replacement, compares every imported field, checks the new migration ledger,
then restores and verifies legacy financial data and migration history. It
generates private replacement/rollback SQL only after those checks pass. Rollback
deliberately keeps bank connections disconnected rather than resurrecting revoked
token references. The allowlisted operations do not drop Auth, Vault, managed
event triggers, or the public schema. A fresh frozen backup and a separate approval
are still required before production execution.

Imported history retains source `plaid` and its stable provider IDs, but no live
connection. CSV duplicate IDs are scoped to the CSV source and do **not**
automatically deduplicate against migrated Plaid records. Choose a nonoverlapping
CSV date range or explicitly review overlaps.

## Validation

With local Supabase running:

```bash
npm run test:unit       # Pure domain tests; no backend required
npm test               # Domain + real Supabase integration
npm run test:db         # pgTAP database invariants
npx playwright install chromium
npm run test:e2e        # Starts Vite if necessary
npm run typecheck
npm run lint
npm run build
```

Integration/browser tests create uniquely named local test accounts and delete
them after completion. They read local test credentials from Supabase CLI
status, not a committed privileged key. Browser artifacts go to gitignored
`test-results/`. Tests cover exact mixed-sign allocations, signed report
fallbacks, exclusions, ownership isolation, duplicate/atomic imports, monthly
copying and snapshots, date moves/unplanned activity, recommendations, browser
persistence, and mobile layout.

Browser tests also verify sign-up and complete password recovery through the
actual local Mailpit email link, as well as keyboard-operated report drill-down.

## Workspace interactions

- Desktop uses a compact sidebar; mobile uses navigation tabs. The shared month
  picker and previous/next controls apply to all three views.
- Budget amounts are read-only until selected. Click a planned amount to edit;
  **Save / Enter** commits, while **Cancel / Escape** discards the draft.
  Changing focus never saves an amount. Validation or connection failures keep
  the draft available for retry.
- Section/category menus contain rename, move, monthly removal, and archive
  actions. **Add section** and **Add category** open focused forms. Copying and
  attaching existing entries are under **Budget actions**.
- Transaction rows expose inline categorization and one-click suggestions.
  Select a transaction's description or details arrow to open its detail sheet:
  allocations/splits, effective-date override/reset, and exclude/restore.
  Partially categorized splits retain independent allocation controls.
- **Filters** reveals category, excluded-state, and sort controls. Search and
  the uncategorized toggle remain directly accessible. Editing a transaction
  can remove it from the current list; a notification explains the result.
- Manual entry and CSV import each have their own dialog. CSV preview and
  duplicate protections are unchanged.
- Unsaved financial drafts prompt before dismissal, navigation, month changes,
  or sign-out. Dialogs and menus support keyboard interaction and restore focus;
  saved data stays in Supabase regardless of whether the web server is running.
- Reports group actual activity separately from the plan, with consistent
  section/category colors, keyboard-operable legends, and responsive signed
  allocation detail. Negative and all-zero totals remain explicit, not pies.

The expanded browser suite checks explicit money-edit semantics, failed-save
retry state, draft dialogs, keyboard/focus behavior, and signed/overspent states.
It measures at least eight ordinary transaction rows visible at 1280x800 and
verifies mobile balances without horizontal scrolling at 360px/390px. Automated
axe accessibility scans cover authentication and all three views; screenshots
are also inspected at desktop, intermediate, and mobile widths.

Run Vite in your own terminal using `npm run dev`. Tests manage a temporary web
server when needed and clean it up; no assistant-managed background server is
required.
