# Invite-only React app

A Vite, React, and TypeScript application with Supabase Magic Link authentication. Users must already be invited or pre-created in Supabase; the browser client never creates accounts.

## Local development

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

   In PowerShell, use `Copy-Item .env.example .env`.

3. Set these values in `.env`:

   | Variable | Purpose |
   | --- | --- |
   | `VITE_APP_NAME` | Product name displayed in the app. |
   | `VITE_SUPABASE_URL` | Supabase project URL. |
   | `VITE_SUPABASE_ANON_KEY` | Supabase browser-safe anonymous/publishable key. |
   | `VITE_SITE_URL` | Exact URL to receive Magic Link redirects; use `http://localhost:5173` locally. |

4. Start the development server:

   ```sh
   npm run dev
   ```

`VITE_` variables are compiled into browser code. Do not put the Supabase service-role key, Vercel token, or any other secret in `.env` values exposed to the application.

## Supabase configuration

1. Create a Supabase project and enable the Email provider under **Authentication**.
2. In **Authentication** URL configuration, set the Site URL to the canonical production `VITE_SITE_URL`. Add both `http://localhost:5173` and the production Vercel URL to Redirect URLs.
3. In **Authentication** settings, disable new-user signups. This makes the Supabase project enforce invite-only access server-side.
4. Invite each authorized user from **Authentication** > **Users**. Invited or pre-created users can subsequently use the app's Magic Link sign-in screen.

The sign-in request passes `shouldCreateUser: false`, so the application does not create an account for an uninvited email address. The Supabase signup setting is still required to prevent other clients from directly invoking signup.

## Plaid transaction imports

The authenticated app can import up to 30 days of initially available
transactions from a user's connected financial accounts. The import stores only
the transaction date, merchant name, signed amount, ISO currency code, pending
state, category, and account name. It does not retain Plaid public tokens,
access tokens, account/routing numbers, balances, raw transaction descriptions,
location data, or identity data.

This is an initial-import-only prototype. After the import request completes,
the server removes the Plaid Item, so users cannot refresh data, receive future
updates, or reconnect in update mode. Users can remove their retained rows with
the **Clear imported data** control.

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
   | `APP_ALLOWED_ORIGINS` | Comma-separated local and production app origins permitted to call the Functions. |

   The Supabase-managed `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` remain server-only Function settings. Never
   expose the service-role key in the browser application.

5. Apply the database migration and deploy the Functions:

   ```sh
   supabase db push
   supabase functions deploy plaid-create-link-token
   supabase functions deploy plaid-import-transactions
   ```

The Vercel workflow still deploys only the static Vite application. Deploy
Supabase migrations and Edge Functions before or alongside a Vercel release
that uses this UI.

## Vercel configuration

`vercel.json` configures Vite's `npm run build` command and the `dist` output directory. Create or link a Vercel project, then set the four `VITE_` variables above in the Vercel project for **Production**. Set `VITE_SITE_URL` to the exact canonical production URL.

If you also enable Vercel preview deployments, set the same browser-safe values for the Preview environment and add the preview redirect URL or a suitable Vercel wildcard redirect rule in Supabase. Keep the Supabase service-role key out of every Vercel `VITE_` variable.

## Production deployment workflow

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds the Vite
application, applies Supabase migrations, deploys all Supabase Edge Functions,
then deploys the prebuilt client to Vercel Production in either case:

- A pull request targeting `main` is closed after being merged.
- Someone selects **Run workflow** from GitHub Actions.

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
| `npm run dev` | Start the local Vite server. |
| `npm run lint` | Run Oxlint. |
| `npm run build` | Type-check and create the production build in `dist`. |
| `npm run preview` | Preview the production build locally. |
