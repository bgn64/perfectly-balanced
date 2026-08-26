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

## Vercel configuration

`vercel.json` configures Vite's `npm run build` command and the `dist` output directory. Create or link a Vercel project, then set the four `VITE_` variables above in the Vercel project for **Production**. Set `VITE_SITE_URL` to the exact canonical production URL.

If you also enable Vercel preview deployments, set the same browser-safe values for the Preview environment and add the preview redirect URL or a suitable Vercel wildcard redirect rule in Supabase. Keep the Supabase service-role key out of every Vercel `VITE_` variable.

## Production deployment workflow

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys the prebuilt Vite application to Vercel Production in either case:

- A pull request targeting `main` is closed after being merged.
- Someone selects **Run workflow** from GitHub Actions.

Before running it, add the GitHub configuration below at repository scope or in
the `production` environment:

| Type | Name | Purpose |
| --- | --- |
| Secret | `VERCEL_TOKEN` | Vercel access token with permission to deploy the project. |
| Variable | `VERCEL_ORG_ID` | Vercel team or personal account ID. |
| Variable | `VERCEL_PROJECT_ID` | Vercel project ID. |

Run `npx vercel link` locally to find the organization and project IDs in the generated `.vercel/project.json`; that directory is intentionally ignored. The workflow pulls Production variables from Vercel, builds with the Vercel CLI, and deploys the resulting prebuilt output. If the project is also connected to Vercel's Git integration, disable its automatic Production deployment to avoid a duplicate deployment for each merge.

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Vite server. |
| `npm run lint` | Run Oxlint. |
| `npm run build` | Type-check and create the production build in `dist`. |
| `npm run preview` | Preview the production build locally. |
