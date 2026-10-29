# Supabase to private Docker Compose

## Boundaries

This is a downtime-friendly migration, not an in-place replacement of Supabase
schemas. Preserve the old system and verified backups until the new system is
accepted. Production export, stopping writers, disconnecting banks, deployment,
DNS/proxy edits and production Plaid activation are separate operator decisions.
Never reset an existing database or execute the historical schema replacement
scripts to make this migration easier.

## 1. Obtain a real financial backup

Start Docker Desktop first. `supabase db dump` uses a PostgreSQL Docker image,
so its initial image download is expected. **Bare `db dump` is schema-only**;
it does not contain your transactions.

After explicitly deciding to export your linked production project:

```powershell
New-Item -ItemType Directory -Force .\backups\supabase-cutover
npx supabase db dump --linked --schema public,app_private --file .\backups\supabase-cutover\schema.sql
npx supabase db dump --linked --schema public,app_private --data-only --use-copy --file .\backups\supabase-cutover\data.sql
```

If inspection shows the old schema has no `app_private`, export `public` alone.
Do not put a database password on the command line or paste it into chat. Retain
the schema dump, data dump and an independent secured copy. Verify the source
project before exporting; never infer that a successful `supabase link` took a
backup. Use new paths instead of overwriting your only copy.

For rollback, application-only exports are **not a complete Supabase backup**.
Separately preserve managed Auth identities, migration history, configuration
and any required provider/Vault recovery material using the provider's backup
procedure. Keep credential-bearing backups especially restricted. Only the
financial data dump enters the SQLite importer; Supabase password hashes,
sessions and Vault access tokens must not be imported.

The importer accepts plain SQL containing `COPY ... FROM stdin`, or gzip of
that format (including compatible downloaded `.backup.gz` files). It does not
execute SQL. For custom-format `PGDMP` archives, convert with a local
`pg_restore --file=data.sql <archive>` first; do not restore into production.
INSERT-based exports must be re-exported using `--use-copy`.

## 2. Inspect, provision and rehearse

Use a new local Compose project name so its volume is isolated:

```powershell
docker compose -p balanced-rehearsal up --build -d
docker compose -p balanced-rehearsal cp .\backups\supabase-cutover\data.sql app:/app/data/source.sql
docker compose -p balanced-rehearsal exec app npm run budget:import -- --dump /app/data/source.sql --inspect
```

Inside-container paths in these commands are Linux paths. PowerShell host paths
use backslashes. Inspection reports source schema, table counts and financial
owner UUIDs, not transaction details. Preserve that inventory privately.

Create each account using exactly its source owner UUID and a new password:

```powershell
docker compose -p balanced-rehearsal exec app npm run account:create
docker compose -p balanced-rehearsal exec app npm run budget:import -- --dump /app/data/source.sql --dry-run --report /app/data/dry-run.json
docker compose -p balanced-rehearsal exec app npm run budget:import -- --dump /app/data/source.sql --report /app/data/import.json
docker compose -p balanced-rehearsal cp app:/app/data/import.json .\backups\supabase-cutover\import.json
```

Do not log into the budget before importing: reading an empty month initializes
its Income/month records, and import correctly refuses nonempty destinations.
If you already explored a disposable rehearsal, choose another project/volume;
do not reset a real database.

The current schema preserves financial row IDs, owner IDs, amounts, sources,
revisions, dates, exclusions, allocations, snapshots and CSV deduplication
history. The legacy schema uses the existing validated category/month
transformation; legacy pending records and their splits remain in the private
source archive rather than entering totals. Unsupported or ambiguous schemas,
unmapped nonempty application tables/columns, invalid data, missing owners and
foreign-key/allocation conflicts abort the import.

Imports are atomic, source/mapping-fingerprinted and field-reconciled. Dry-run
rolls back all rows. Real import first backs up SQLite. An identical imported
source is a no-op, preserving later edits; changing owner mappings is rejected.
Reports include counts, exact field-match confirmation and per-owner/month
signed/included cents. Review against the source before proceeding.

Old Plaid metadata/reviews/audits are preserved inertly in the server-only
`historical_provider_data` SQLite table; original backups remain authoritative.
They are not live bank connections or automatically actionable new reviews.
Old tokens, live cursors, leases and queued work are not imported. Use a private
SQLite inspection tool on a backup to review this archive alongside the source.
Unresolved historical provider decisions need explicit manual review; reconnecting
does not imply matching an old account. Do not delete the source archive.

## 3. Verify the actual container

Use only fictional data or your explicitly imported private rehearsal. Check:

- Health in `docker compose ps`; logs contain no secrets.
- Signed-out deep links show login; unauthenticated API writes fail.
- Login, monthly plans, copy/rename/order, manual and CSV transactions, splits,
  exclusions, overrides, recommendations, reports and category drill-down.
- Logout removes access, password reset revokes sessions, narrow/mobile layouts
  work, refresh preserves deep links.
- Stop/start preserves data. A backup restored into a separate volume yields
  the same financial state.
- Plaid Sandbox connection, selected accounts, polling/manual sync, pending,
  history readiness, conflict decisions, reconnect and disconnect.

`npm run test:hosting` tests the production build against a temporary database.
To run it against a disposable running container, provision the fictional
`browser@example.test` / `browser-test-password-12345` account there and set
`CONTAINER_TEST_URL` to its local origin. Never provision this account on the
real server. This suite intentionally writes fictional transactions.

## 4. Plaid without inbound callbacks

Set `PLAID_ENABLED=true`, Sandbox credentials, and a separately generated
32-byte hex `PLAID_TOKEN_KEY` in the private `.env`. Restart/recreate the service.
Local `APP_ENV=local` rejects production Plaid. Production requires the explicit
`APP_ENV=server`, HTTPS canonical URL, and `PLAID_ENVIRONMENT=production`.

The app's worker requests available changes outbound. `PLAID_POLL_HOURS=6`
is the default; `0` disables recurring polling after initial history catch-up.
Manual **Sync now** remains available. Initial readiness is checked through
outbound sync responses, not webhooks. Last success, pending records, review
counts and errors appear on Connections. Bank freshness is controlled by Plaid/
the institution; this does not automatically invoke a paid refresh product.

No webhook URL is registered and no webhook endpoint is served. Bank Link may
redirect the **browser** to `/connections`; that remains necessary for OAuth
banks. Register the exact HTTPS canonical return URI in Plaid. The user's
browser must resolve/reach it on the LAN/VPN. Sandbox non-OAuth Link works on
local HTTP; OAuth tests need a registered HTTPS origin. Confirm private return
compatibility with the banks you use before cutting over; do not expose an
endpoint publicly as an undocumented workaround.

New access tokens use AES-256-GCM authenticated encryption in SQLite. Keep
`PLAID_TOKEN_KEY` outside the database/image and back it up separately.
Do not replace it while connected Items exist. For key rotation, disconnect
Items through the app, verify success, replace the key and reconnect manually.
Changing only the key does not re-encrypt old tokens. Losing it requires bank
reconnection; never log decrypted tokens to recover a connection.

## 5. Consistent backup and isolated restore

```powershell
docker compose exec app npm run db:backup -- /app/data/manual-backup.sqlite
docker compose cp app:/app/data/manual-backup.sqlite .\backups\manual-backup.sqlite
```

The backup command uses SQLite's online backup API; do not copy a live main
database alone and ignore its WAL. Back up the entire database (accounts,
sessions, finances and encrypted tokens), authentication secret and encryption
key, keeping keys separately protected. Financial backups are not deployment
artifacts and must never be committed.

For restore, stop writers first. Use a separate Compose project/volume, securely
copy the backup as `perfectly-balanced.sqlite` while its service is stopped,
ensure UID/GID 1000 can write the volume, then start with the correct keys.
Do not overwrite a mounted live database, mix old WAL/SHM sidecars with a
restored main file, or restore over your only working copy. Verify
`PRAGMA integrity_check`, foreign keys, login and reconciliation in the isolated
restore before adopting it. A restored database with live tokens must not run a
second production Plaid worker alongside the original.

## 6. Server and Caddy

Move the tested source/image and consistent database backup using a private
channel. Use a separate server `.env`, stable volume and the canonical HTTPS
origin, e.g. `BETTER_AUTH_URL=https://perfectly-balanced.bgalindo.dev`.
The image contains no machine-specific hostname, secrets or financial data.

For Caddy on the host, keep Compose's default loopback binding:

```caddyfile
perfectly-balanced.bgalindo.dev {
    reverse_proxy 127.0.0.1:3000
}
```

For Caddy in Docker, attach Caddy and `app` to an explicitly shared private
Docker network, omit published app ports in the server Compose configuration,
and proxy to `app:3000` using a unique network alias if necessary. Container
loopback does not refer to the host. Do not bind the app to all LAN interfaces
just to make the proxy work. Keep trusted origin/forwarded-header handling at
the controlled Caddy boundary.

Cloudflare DNS should resolve only the intended application hostname to your
LAN server address (DNS only). Keep other records unchanged; no WAN port
forwarding is required. Private-only TLS generally needs your existing Caddy
DNS-01 setup (Cloudflare DNS module/API token) or another trusted certificate
strategy; a DNS record alone does not provide a certificate. Do not place the
Cloudflare API token in the app container.

Compose runs non-root with dropped capabilities, health checks and explicit
restart/graceful-shutdown behavior. Keep the SQLite volume on local disk, not
SMB/NFS. Match the image architecture to the server and verify file permissions.

## 7. Final maintenance and rollback

After local acceptance and separate approval:

1. Verify complete rollback backups and the isolated restore rehearsal.
2. Freeze edits and stop **all** old writers/schedulers, including legacy jobs.
3. Take final financial exports and reconcile them with the source.
4. Explicitly disconnect/revoke old Plaid Items; retain evidence and update the
   maintenance inventory. Do not restore their tokens/jobs in the new runtime.
5. Provision/import/reconcile into the final SQLite volume, securely transfer
   and verify it, then start behind Caddy with polling initially disabled.
6. Change only the intended proxy/DNS target, verify login and financial data,
   then explicitly activate production Plaid and reconnect banks manually.
7. Review overlaps against imported history before accepting matches. Retain
   old deployment/backups until acceptance.

Rollback first stops new writers and accounts for new edits. Point back only
to the deliberately retained old application/database state. Database restore
does not undo a Plaid disconnection: never silently reactivate legacy Items or
restart old ingestion. A Supabase schema replacement is not part of this flow.
