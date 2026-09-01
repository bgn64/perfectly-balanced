# Invite-only React app

A Vite, React, and TypeScript application with Supabase Magic Link authentication. Users must already be invited or pre-created in Supabase; the browser client never creates accounts.

## Local Docker development

Use the local development stack for everyday UI, migration, and database
testing. It runs Supabase entirely in Docker and never connects to the
production Supabase project.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) must be
  installed and running.
- Node.js and npm must be installed.

### Start the app

1. Install dependencies:

   ```sh
   npm install
   ```

2. Start local Supabase and Vite:

   ```sh
   npm run dev
   ```

   The `predev` hook checks Docker, starts or reuses the Supabase CLI Docker
   stack, and generates `.env.development.local` from `supabase status --output
   env` before Vite starts. This file is loaded only by development-mode Vite
   runs, never production builds. It contains only browser-safe local client
   configuration: app name, site URL, API URL, anonymous key, local-demo flag,
   and local fixture credentials. It never contains a service-role key or
   production credential.

3. Sign in with the development-only test account:

   | Field | Value |
   | --- | --- |
   | Email | `dev@example.test` |
   | Password | `local-dev-password` |

   This account is recreated by the local seed fixture and signs in through
   Supabase Auth, so the application continues to exercise normal JWT, RLS,
   and RPC authorization.

### Local database lifecycle

| Command | Purpose |
| --- | --- |
| `npm run local:up` | Start or reuse local Supabase and generate `.env.development.local`. |
| `npm run local:reset` | Rebuild the local database, apply every migration, and recreate deterministic seed data. |
| `npm run local:down` | Stop the local Supabase Docker stack while preserving its volumes. |
| `npm run dev` | Run `local:up`, then start Vite. |

The local seed includes a confirmed development user, an August 2026 budget
with root and sectioned allocations, categorized transactions, and one
uncategorized transaction. It creates no Plaid Items, webhook events, Vault
secrets, or bank data.

`VITE_LOCAL_DEMO_MODE` is generated only for local development. The client
rejects it in production builds or when its Supabase URL is not localhost.
Do not put a Supabase service-role key, Vercel token, Plaid credential, or
other secret in a `VITE_` value.

Local Supabase keeps `[auth].enable_signup = false` to prevent new user
registration while enabling the email provider for the seeded account. The
separate `[auth.email].enable_signup = true` setting is required by the local
Supabase CLI to permit email/password and Magic Link login.
After changing `supabase/config.toml`, run `npm run local:down` followed by
`npm run local:reset` to recreate the local Auth container with the new
configuration.

### Hosted client configuration

For Vercel or another hosted client deployment, provide the browser-safe values
below. Do not set `VITE_LOCAL_DEMO_MODE=true` for a remote project.

| Variable | Purpose |
| --- | --- |
| `VITE_APP_NAME` | Product name displayed in the app. |
| `VITE_SUPABASE_URL` | Hosted Supabase project URL. |
| `VITE_SUPABASE_ANON_KEY` | Supabase browser-safe anonymous/publishable key. |
| `VITE_SITE_URL` | Exact URL to receive Magic Link redirects. |

## Supabase configuration

1. Create a Supabase project and enable the Email provider under **Authentication**.
2. In **Authentication** URL configuration, set the Site URL to the canonical production `VITE_SITE_URL`. Add both `http://localhost:5173` and the production Vercel URL to Redirect URLs.
3. In **Authentication** settings, disable new-user signups. This makes the Supabase project enforce invite-only access server-side.
4. Invite each authorized user from **Authentication** > **Users**. Invited or pre-created users can subsequently use the app's Magic Link sign-in screen.

The sign-in request passes `shouldCreateUser: false`, so the application does not create an account for an uninvited email address. The Supabase signup setting is still required to prevent other clients from directly invoking signup.

## Plaid transaction synchronization

The authenticated app connects multiple financial institutions and imports up
to 90 days of initially available transaction history. The import stores only
the transaction date, merchant name, a cleaned transaction-name fallback only
when no merchant is available, signed amount, ISO currency code, pending state,
category, account name, and source connection. It does not retain
account/routing numbers, balances, raw transaction descriptions, location data,
or identity data.

Each active Plaid Item access token is stored encrypted at rest in Supabase
Vault. Only narrowly scoped database routines called by server-side Edge
Functions can decrypt a token, and only while making a Plaid API request. The
browser cannot query the Vault, token records, sync cursors, or webhook events.

Plaid's standard `SYNC_UPDATES_AVAILABLE` webhooks trigger cursor-based
transaction synchronization. This avoids the paid Transactions Refresh add-on;
Plaid normally checks institutions one to four times per day. A newly connected
bank can take time to prepare historical data, so the UI shows connection status
and displays transaction batches as they become available.

If a connection is still preparing history after a delayed webhook, the
**Check available transactions** action safely retries `/transactions/sync`
against the retained Item. It reads data Plaid has already prepared and does not
call the paid Transactions Refresh endpoint.

Disconnecting a bank removes the Plaid Item and deletes its encrypted access
token, stopping future updates while retaining already imported history. A user
can permanently delete saved history only after disconnecting that Item.

### Local Plaid boundary

The local development bootstrap does not serve Edge Functions or configure
Plaid credentials. The local fixture deliberately contains no Plaid Items or
transaction-ingestion state. Do not add live Plaid credentials to
`.env.development.local`, and do not use the local stack to authorize financial
institutions or ingest bank data.

### Live Plaid setup

1. Obtain a live Plaid production application with the **Transactions** product
   enabled for every country your prototype supports.
2. Configure the production app's Link OAuth redirect URI as the app's
   canonical `VITE_SITE_URL`. Add the same URL to Plaid's Allowed Redirect URIs.
3. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), log in, and
   link the local project to the target Supabase project.
4. Set these **Supabase Edge Function secrets**. Do not use `VITE_` names and
   do not put them in the Vercel project environment:

   | Name | Purpose |
   | --- | --- |
   | `PLAID_CLIENT_ID` | Plaid production client ID. |
   | `PLAID_SECRET` | Plaid production secret. |
   | `PLAID_ENVIRONMENT` | Must be `production` for this live integration. |
   | `PLAID_CLIENT_NAME` | Name displayed in Plaid Link. |
   | `PLAID_COUNTRY_CODES` | Comma-separated supported country codes, such as `US`. |
   | `PLAID_REDIRECT_URI` | Exact canonical app URL registered with Plaid. |
   | `PLAID_WEBHOOK_URL` | Exact deployed `plaid-transactions-webhook` Function URL. |
   | `APP_ALLOWED_ORIGINS` | Comma-separated local and production app origins permitted to call the Functions. |

   The Supabase-managed `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` remain server-only Function settings. Never
   expose the service-role key in the browser application.

5. Set `PLAID_WEBHOOK_URL` to the production Supabase Function endpoint:

   ```text
   https://<supabase-project-ref>.supabase.co/functions/v1/plaid-transactions-webhook
   ```

   The endpoint is public so Plaid can call it, but it verifies every
   `Plaid-Verification` signature, request-body digest, and timestamp before
   accepting a webhook.

6. Apply the database migration and deploy the Functions:

   ```sh
   supabase db push
   supabase functions deploy
   ```

The production GitHub Action applies migrations and deploys all Functions before
releasing the Vercel client. Configure the required GitHub `production`
environment secrets and variable described below before merging a deployment.

## Vercel configuration

`vercel.json` configures Vite's `npm run build` command and the `dist` output directory. Create or link a Vercel project, then set the four `VITE_` variables above in the Vercel project for **Production**. Set `VITE_SITE_URL` to the exact canonical production URL.

If you also enable Vercel preview deployments, set the same browser-safe values for the Preview environment and add the preview redirect URL or a suitable Vercel wildcard redirect rule in Supabase. Keep the Supabase service-role key out of every Vercel `VITE_` variable.

## Production deployment workflow

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) builds the Vite
application, then conditionally applies Supabase migrations and deploys
Supabase Edge Functions before publishing the prebuilt client to Vercel
Production in either case:

- A pull request targeting `main` is closed after being merged.
- Someone selects **Run workflow** from GitHub Actions.

For a merged pull request, the workflow only runs `supabase db push` when files
under `supabase/migrations/` changed, and only deploys Functions when
`supabase/functions/` or `supabase/config.toml` changed. Supabase migration
history also makes `db push` safe when all committed migrations are already
applied. A manual workflow run intentionally deploys both migrations and
Functions so an operator can reconcile the full configured state.

Before running it, add the GitHub configuration below at repository scope or in
the `production` environment:

| Type | Name | Purpose |
| --- | --- |
| Secret | `VERCEL_TOKEN` | Vercel access token with permission to deploy the project. |
| Variable | `VERCEL_ORG_ID` | Vercel team or personal account ID. |
| Variable | `VERCEL_PROJECT_ID` | Vercel project ID. |
| Secret | `SUPABASE_ACCESS_TOKEN` | Personal access token used by the Supabase CLI in GitHub Actions. |
| Secret | `SUPABASE_DB_PASSWORD` | Production Supabase database password used to apply migrations. |
| Variable | `SUPABASE_PROJECT_ID` | Production Supabase project reference. This is not a secret. |

Run `npx vercel link` locally to find the organization and project IDs in the generated `.vercel/project.json`; that directory is intentionally ignored. The workflow pulls Production variables from Vercel, builds with the Vercel CLI, and deploys the resulting prebuilt output. If the project is also connected to Vercel's Git integration, disable its automatic Production deployment to avoid a duplicate deployment for each merge.

Add the Supabase values to the same GitHub `production` environment before
merging. Plaid credentials remain Supabase Edge Function secrets and must not be
copied into GitHub Actions.

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Supabase Docker stack and Vite. |
| `npm run local:up` | Start/reuse local Supabase and generate local browser configuration. |
| `npm run local:reset` | Rebuild local Supabase from migrations and deterministic seed data. |
| `npm run local:down` | Stop local Supabase Docker containers. |
| `npm run lint` | Run Oxlint. |
| `npm run build` | Type-check and create the production build in `dist`. |
| `npm run mockup` | Serve the static UI mockup from `mockup/` for review. |
| `npm run preview` | Preview the production build locally. |

## UI mockup and agent workflow

`mockup/` is the committed, static, current-state rendering of the app's UI.
It contains no application logic, authentication, network requests, database
calls, or Plaid behavior. When multiple mockup pages are needed, their shared
navigation keeps the screens connected.

Before making a UI-changing feature, Copilot must update and serve the mockup
with `npm run mockup`, obtain explicit visual approval, then create a
database-aware implementation plan and obtain approval again before changing
application code. Every shipped UI change must include its matching `mockup/`
update in the same commit or pull request.

The repository expects an externally configured `ui-automation` MCP for final
UI smoke testing. Until a safe local or staging Plaid integration exists, UI
automation must never operate any live Plaid bank-connection control or mutate
real transaction data.
