# Perfectly Balanced

A budgeting web app with monthly budgets, efficient transaction categorization,
and drill-down income/spending reports. USD only. Optional Plaid connections
automatically ingest transactions through a trusted backend; manual and CSV
workflows do not require bank credentials.

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
  transaction side panel, including clearly marked excluded activity. Sections must be emptied before monthly removal. Archiving
  catalog entries preserves history but hides them from new assignments.
- Charts retain signed net values. Negative buckets use a signed list with the
  same drill-down controls rather than taking absolute values. Empty or
  all-zero totals have an empty state. Every chart has keyboard-operable textual
  alternatives. Zero-valued buckets stay in the breakdown, not pie wedges.
- Actual reports can omit uncategorized allocations without omitting assigned
  portions of split transactions. Planned reports show only planned amounts.
- There is one Income section, so its section-level pie is normally one slice
  (plus uncategorized income, if enabled); drill into it to see income categories.

### In-place category inspection

Budget category names (including unplanned activity) and actual report categories
open the same transaction side panel without navigating away. Reports show only
contributing allocations; Budget also includes excluded records for review.
Category amounts and full net totals are separate from signed parent transaction
amounts, so splits are never double counted. Long transaction lists paginate.

Open a transaction to categorize, split, exclude, or change its effective date
using the same controls as Transactions. If it leaves the current category view,
the detail sheet closes back to that list with an explanation. Closing the panel
returns focus to its launcher; the originating page and report level stay in place.

Report cards reserve their layout during section drill-down, with persistent
breadcrumbs and independently scrollable long breakdowns. Signed and zero-total
fallbacks retain accurate amounts. Planned category inspection shows its planned
amount in a panel rather than showing transactions or replacing the chart.

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
exclusions, and date overrides. Plaid Edge Functions normalize provider records
and execute calls/webhooks on the trusted backend. Tokens are encrypted in Vault;
provider state, cursors, staged pages, durable jobs and review decisions are not
browser-writable. Pending activity and ambiguous duplicates are kept outside
financial totals. Financial conflicts keep the last accepted version until
review. Accepted bank removals are retained separately from user exclusions and
can be undone from transaction details.

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

Cutover rehearsals/replacement remain pinned to the frozen initial schema
through migration `20261002000500`; later live-ingestion migrations are separate
additive upgrades. Do not rerun replacement against an already cut-over app.

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

Imported history retains source `plaid` and provider IDs, but no live
connection or assumed account mapping. Fresh bank authorization is required.
CSV duplicate IDs remain scoped to the CSV source; CSV imports do **not**
automatically deduplicate against Plaid. Bank ingestion holds likely overlaps
against existing history for review rather than silently merging equal-looking
purchases.

## Plaid connections

**Connections** supports Transactions for selected depository and credit
accounts. Balances, investments, liabilities, transfers and automatic category
assignment are not included. Bank credentials are entered only in Plaid/bank
authorization, never in the app. Production stays private and signup-disabled.

Choose an inclusive import start date before connecting. New connections default
to today's date in your local time zone. Choose an earlier date to include past
activity or fill a gap in your existing history. Possible duplicates wait for
review rather than silently entering your totals. Plaid
requests up to 730 days; institution availability may be shorter. Data outside
the start date is staged but does not create new financial transactions.
Date boundaries use provider calendar dates.

After authorization, select eligible accounts to start sync. Selecting another
account can ingest its available staged history under the same start-date and
review rules; deselection retains existing transactions. Pending activity is
shown separately, outside budgets/reports. Posted transactions enter uncategorized.
Pending-to-posted identity is reconciled across all pages. Migrated pending
records remain accepted history unless explicitly reconciled.

Exact provider identities are idempotent. Fresh authorization can change IDs;
similar date/amount/payee matches are **candidates, not proof**. Review held
activity as an existing transaction, a separate purchase, or do not import.
Amount changes on assigned/split transactions and removed posted transactions
retain accepted totals until reviewed. Changed amounts require allocations
that sum exactly, while preserving category assignments, date overrides and
exclusions. Metadata-only provider updates preserve user edits. Conflicting
provider/user versions must be refreshed before resolving.

Disconnect revokes Plaid access, removes the Vault token and fences running
workers while keeping accepted financial history. Failures remain visible and
retryable. Reconnect repairs an existing Item through Link update mode; an
already disconnected Item needs new bank authorization.

### Local Sandbox setup

Use your **Sandbox** credentials only. Local configuration rejects Production
and remote production Supabase; production configuration rejects Sandbox.
Credentials, tokens and worker secrets must never be `VITE_*` values.

```bash
npm run plaid:setup
# Edit supabase/.env.local: set PLAID_CLIENT_ID and PLAID_SECRET.
# The setup command generates a private random PLAID_WORKER_SECRET.
npm run plaid:serve
```

The file is gitignored and created with 0600 permissions; setup refuses to
overwrite it. The default HTTP app supports non-OAuth Sandbox banks without a
redirect URI. **Plaid requires HTTPS for OAuth redirects even in Sandbox.**
Do not configure an HTTP redirect URI.

For local OAuth testing, `npm run plaid:setup:https` generates private, short-lived
self-signed localhost certificates (requires OpenSSL), adds the HTTPS app origin
to the backend allowlist, and sets its redirect URI. It refuses to overwrite
existing certificates. Register `https://127.0.0.1:5174/connections` in the
Sandbox Plaid Dashboard, trust the certificate locally, restart the functions,
and use `npm run dev:https` at `https://127.0.0.1:5174`. Sign in on that origin
before connecting; browser sessions are origin-specific. Local Supabase stays
Docker-backed. Do not use a production backend or real bank credentials.

In a separate terminal, schedule the local worker:

```bash
npm run plaid:schedule:local
```

The worker runs once a minute, taking one bounded page/job with a fenced lease.
Paginated changes are staged; the accepted cursor and all financial changes
commit atomically only after the complete update. Pagination mutation errors
discard staged progress and restart from the original cursor. Failed jobs
back off and stop automatic retries after eight failures, with visible status;
manual retry resets the attempt count. New connections catch up frequently
while history loads, then periodically check for missed webhooks.

Plaid cannot send webhooks to localhost. Local scheduled/manual catch-up works
without a public tunnel; history-completion flags remain explicitly unconfirmed
without a webhook. An optional controlled Sandbox-only HTTPS tunnel can test
signed webhook delivery. The worker does not call the billable
`/transactions/refresh`; “Sync now” reads updates Plaid already has, not an
instant bank refresh.

For Sandbox tests, First Platypus Bank (`ins_109508`) supports non-OAuth testing;
`user_transactions_dynamic` with a nonblank test password provides pending/
posted scenarios. In Link, continue without a phone number, search for First
Platypus Bank, then select the associated institution without "OAuth" in its
name. The OAuth variants require the HTTPS setup above.
Sandbox uses Plaid's real authorization interface but **does
not accept your real bank login** or connect to real accounts. The Connections
page shows test-bank instructions only in development; production does not show
Sandbox instructions or one-time migration guidance. For existing test activity,
choose an earlier import date (for example, thirty days ago); today's default
imports new activity only. Also test an OAuth Sandbox institution. Never use real bank
credentials in local tests. Automated tests use synthetic provider/Link data
against real local persistence, not Production.

### Production activation and operations

The existing frontend workflow remains manual. **Deploy Plaid backend** is a
separate manual Production-environment workflow requiring `main`,
`deploy-plaid`, and `BUDGET_SCHEMA_READY=true`. It applies additive migrations,
deploys the three functions, configures secrets and schedules sync. It never
performs the legacy schema replacement or restores old tokens.

Before explicitly approving/running it:

- Verify the new-schema migration ledger, backups and local checks.
- Configure Production environment secrets: `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`, `PLAID_CLIENT_ID`,
  `PLAID_SECRET`, and a random `PLAID_WORKER_SECRET` of at least 32 characters.
- Confirm Plaid Production Transactions access, billing, institution/OAuth
  registration and `https://perfectly-balanced.vercel.app/connections` redirect.
- Use the exact hosted webhook URL:
  `https://hqeoxulnpkksxvoyxlvq.supabase.co/functions/v1/plaid-webhook`.
- Review origins and secrets before backend activation, then deploy the matching
  frontend separately. Authorize banks only after checking status/errors.

User endpoints validate Supabase sessions directly; the external webhook validates
ES256, Plaid verification keys, freshness and the raw-body digest; the worker
requires a fresh, one-use HMAC-signed dispatch from its dedicated Vault secret.
The signing secret is never copied into HTTP headers or scheduler request queues.
Gateway JWT checks are disabled **only because**
these endpoints implement their respective authentication. Vault and private
ingestion tables are not client-readable. Supabase-managed `pg_net` queue grants
can be broad; queued payloads contain only short-lived signatures, never reusable
credentials, and replay receipts prevent reuse. Logs contain sanitized error codes, not
provider request bodies/access tokens.

Monitor connection errors, Edge Function logs, `cron.job_run_details` and
`net._http_response` as an administrator. Successful cron SQL is not proof of
successful HTTP sync. Inspect last successful sync and unresolved review/invalid
data counts too. Retried/coalesced webhook deliveries do not create duplicate
accepted transactions. Unsupported currency, zero amounts and invalid records
are durable visible issues rather than silently skipped.

To stop background dispatch, an administrator can run
`select cron.unschedule('plaid-sync-worker');`. This stops dispatch, not consent:
disconnect Items in the app to revoke access and stop ingestion. Existing
transactions must not be removed/reset as a rollback technique. Rotate the worker
secret in Edge Function configuration and the scheduler Vault entry together.
For local rotation, run `node scripts/plaid/rotate-local-worker.ts`, restart
functions, then run `npm run plaid:schedule:local`.

Backend validation:

```bash
npm run test:plaid
npm run check:functions
npm run test:functions
npm run test:sandbox   # Opt-in real Sandbox smoke; isolated local test user/Item
npm run test:sandbox:link # Real Link authorization and automatic local ingestion; requires web/functions/scheduler
```

The Link browser smoke uses an isolated local user and the non-OAuth Sandbox
test bank, selects an eligible account, and verifies that scheduled sync imports
posted transactions. It disconnects its authorized Sandbox Item and deletes
the test user afterward. No real bank credentials or production data are used.

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
