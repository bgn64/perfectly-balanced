create extension if not exists supabase_vault with schema vault;

create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plaid_item_id text not null unique,
  vault_secret_id uuid unique,
  institution_id text,
  institution_name text,
  status text not null default 'initial_syncing' check (
    status in (
      'initial_syncing',
      'active',
      'needs_reconnect',
      'error',
      'disconnected'
    )
  ),
  sync_cursor text,
  initial_update_complete boolean not null default false,
  historical_update_complete boolean not null default false,
  sync_started_at timestamptz,
  last_synced_at timestamptz,
  last_error_code text,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plaid_items_connection_state_check check (
    (status = 'disconnected') = (vault_secret_id is null)
  )
);

create index plaid_items_user_id_idx on public.plaid_items (user_id);
create index plaid_items_active_sync_idx
  on public.plaid_items (status, sync_started_at)
  where status <> 'disconnected';

create table public.plaid_webhook_events (
  delivery_key text primary key,
  plaid_item_id uuid not null references public.plaid_items (id) on delete cascade,
  received_at timestamptz not null default now()
);

alter table public.transactions
  add column plaid_item_id uuid references public.plaid_items (id)
  on delete set null;

alter table public.transactions
  add column plaid_account_id text;

create index transactions_plaid_item_date_idx
  on public.transactions (plaid_item_id, transaction_date desc);

insert into public.plaid_items (
  user_id,
  plaid_item_id,
  institution_name,
  status,
  disconnected_at
)
select distinct
  transactions.user_id,
  'legacy-' || transactions.user_id::text,
  'Previous import',
  'disconnected',
  now()
from public.transactions
where transactions.plaid_item_id is null
on conflict (plaid_item_id) do nothing;

update public.transactions
set plaid_item_id = items.id
from public.plaid_items as items
where public.transactions.plaid_item_id is null
  and items.plaid_item_id = 'legacy-' || public.transactions.user_id::text;

alter table public.plaid_items enable row level security;
alter table public.plaid_webhook_events enable row level security;

revoke all on table public.plaid_items from anon, authenticated;
grant select on table public.plaid_items to authenticated;

create policy "Users can view their own Plaid connections"
  on public.plaid_items
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.plaid_webhook_events from anon, authenticated;

drop policy if exists "Users can delete their own transactions" on public.transactions;
revoke delete on table public.transactions from authenticated;

drop function if exists public.replace_transactions_for_user(uuid, jsonb);

create or replace function public.create_plaid_item(
  p_user_id uuid,
  p_plaid_item_id text,
  p_access_token text,
  p_institution_id text,
  p_institution_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_item_id uuid;
  v_secret_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'create_plaid_item is restricted to the service role';
  end if;

  select id into v_item_id
  from public.plaid_items
  where plaid_item_id = p_plaid_item_id;

  if v_item_id is not null then
    return v_item_id;
  end if;

  select vault.create_secret(
    p_access_token,
    null,
    'Plaid access token'
  ) into v_secret_id;

  insert into public.plaid_items (
    user_id,
    plaid_item_id,
    vault_secret_id,
    institution_id,
    institution_name
  )
  values (
    p_user_id,
    p_plaid_item_id,
    v_secret_id,
    nullif(p_institution_id, ''),
    nullif(p_institution_name, '')
  )
  returning id into v_item_id;

  return v_item_id;
end;
$$;

create or replace function public.claim_plaid_item_sync(
  p_item_id uuid
)
returns table (
  item_id uuid,
  plaid_item_id text,
  access_token text,
  sync_cursor text
)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'claim_plaid_item_sync is restricted to the service role';
  end if;

  return query
  with claimed as (
    update public.plaid_items
    set sync_started_at = now(),
        updated_at = now(),
        last_error_code = null
    where id = p_item_id
      and vault_secret_id is not null
      and status <> 'disconnected'
      and (
        sync_started_at is null
        or sync_started_at < now() - interval '10 minutes'
      )
    returning id, plaid_item_id, vault_secret_id, sync_cursor
  )
  select
    claimed.id,
    claimed.plaid_item_id,
    secrets.decrypted_secret,
    claimed.sync_cursor
  from claimed
  join vault.decrypted_secrets as secrets
    on secrets.id = claimed.vault_secret_id;
end;
$$;

create or replace function public.apply_plaid_transaction_sync(
  p_item_id uuid,
  p_next_cursor text,
  p_added jsonb,
  p_modified jsonb,
  p_removed text[],
  p_initial_update_complete boolean,
  p_historical_update_complete boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_row_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'apply_plaid_transaction_sync is restricted to the service role';
  end if;

  if jsonb_typeof(p_added) <> 'array' or jsonb_typeof(p_modified) <> 'array' then
    raise exception 'Transaction updates must be JSON arrays';
  end if;

  select user_id into v_user_id
  from public.plaid_items
  where id = p_item_id
    and status <> 'disconnected'
  for update;

  if v_user_id is null then
    raise exception 'Plaid Item is not active';
  end if;

  insert into public.transactions (
    user_id,
    plaid_item_id,
    source_transaction_id,
    transaction_date,
    merchant_name,
    amount,
    currency_code,
    is_pending,
    category,
    account_name,
    plaid_account_id
  )
  select
    v_user_id,
    p_item_id,
    updates.source_transaction_id,
    updates.transaction_date,
    updates.merchant_name,
    updates.amount,
    updates.currency_code,
    updates.is_pending,
    updates.category,
    updates.account_name,
    updates.plaid_account_id
  from jsonb_to_recordset(p_added || p_modified) as updates(
    source_transaction_id text,
    transaction_date date,
    merchant_name text,
    amount numeric,
    currency_code text,
    is_pending boolean,
    category text,
    account_name text,
    plaid_account_id text
  )
  on conflict (user_id, source_transaction_id) do update
  set plaid_item_id = excluded.plaid_item_id,
      transaction_date = excluded.transaction_date,
      merchant_name = excluded.merchant_name,
      amount = excluded.amount,
      currency_code = excluded.currency_code,
      is_pending = excluded.is_pending,
      category = excluded.category,
      account_name = excluded.account_name,
      plaid_account_id = excluded.plaid_account_id,
      imported_at = now();

  get diagnostics v_row_count = row_count;

  delete from public.transactions
  where plaid_item_id = p_item_id
    and source_transaction_id = any(coalesce(p_removed, array[]::text[]));

  update public.plaid_items
  set sync_cursor = p_next_cursor,
      initial_update_complete = initial_update_complete or p_initial_update_complete,
      historical_update_complete = historical_update_complete or p_historical_update_complete,
      status = case
        when initial_update_complete or p_initial_update_complete then 'active'
        else 'initial_syncing'
      end,
      sync_started_at = null,
      last_synced_at = now(),
      last_error_code = null,
      updated_at = now()
  where id = p_item_id;

  return v_row_count;
end;
$$;

create or replace function public.record_plaid_item_sync_failure(
  p_item_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'record_plaid_item_sync_failure is restricted to the service role';
  end if;

  update public.plaid_items
  set status = case
        when p_error_code = 'ITEM_LOGIN_REQUIRED' then 'needs_reconnect'
        else 'error'
      end,
      sync_started_at = null,
      last_error_code = nullif(p_error_code, ''),
      updated_at = now()
  where id = p_item_id
    and status <> 'disconnected';
end;
$$;

create or replace function public.get_plaid_item_token_for_user(
  p_item_id uuid,
  p_user_id uuid
)
returns table (
  plaid_item_id text,
  access_token text
)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'get_plaid_item_token_for_user is restricted to the service role';
  end if;

  return query
  select
    item.plaid_item_id,
    secrets.decrypted_secret
  from public.plaid_items as item
  join vault.decrypted_secrets as secrets
    on secrets.id = item.vault_secret_id
  where item.id = p_item_id
    and item.user_id = p_user_id
    and item.status <> 'disconnected';
end;
$$;

create or replace function public.disconnect_plaid_item(
  p_item_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'disconnect_plaid_item is restricted to the service role';
  end if;

  select vault_secret_id into v_secret_id
  from public.plaid_items
  where id = p_item_id
    and user_id = p_user_id
    and status <> 'disconnected'
  for update;

  if v_secret_id is null then
    raise exception 'Active Plaid Item was not found';
  end if;

  delete from vault.secrets
  where id = v_secret_id;

  update public.plaid_items
  set vault_secret_id = null,
      status = 'disconnected',
      sync_started_at = null,
      disconnected_at = now(),
      updated_at = now()
  where id = p_item_id;
end;
$$;

create or replace function public.delete_disconnected_plaid_history(
  p_item_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'delete_disconnected_plaid_history is restricted to the service role';
  end if;

  delete from public.transactions
  where plaid_item_id = p_item_id
    and user_id = p_user_id
    and exists (
      select 1
      from public.plaid_items
      where id = p_item_id
        and user_id = p_user_id
        and status = 'disconnected'
    );

  delete from public.plaid_items
  where id = p_item_id
    and user_id = p_user_id
    and status = 'disconnected';
end;
$$;

create or replace function public.revoke_plaid_account_from_webhook(
  p_item_id uuid,
  p_plaid_account_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'revoke_plaid_account_from_webhook is restricted to the service role';
  end if;

  delete from public.transactions
  where plaid_item_id = p_item_id
    and plaid_account_id = p_plaid_account_id;
end;
$$;

create or replace function public.revoke_plaid_item_from_webhook(
  p_item_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'revoke_plaid_item_from_webhook is restricted to the service role';
  end if;

  select vault_secret_id into v_secret_id
  from public.plaid_items
  where id = p_item_id
    and status <> 'disconnected'
  for update;

  if v_secret_id is null then
    return;
  end if;

  delete from vault.secrets
  where id = v_secret_id;

  update public.plaid_items
  set vault_secret_id = null,
      status = 'disconnected',
      sync_started_at = null,
      last_error_code = nullif(p_error_code, ''),
      disconnected_at = now(),
      updated_at = now()
  where id = p_item_id;
end;
$$;

revoke all on function public.create_plaid_item(uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_plaid_item_sync(uuid)
  from public, anon, authenticated;
revoke all on function public.apply_plaid_transaction_sync(
  uuid,
  text,
  jsonb,
  jsonb,
  text[],
  boolean,
  boolean
) from public, anon, authenticated;
revoke all on function public.record_plaid_item_sync_failure(uuid, text)
  from public, anon, authenticated;
revoke all on function public.get_plaid_item_token_for_user(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.disconnect_plaid_item(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.delete_disconnected_plaid_history(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_plaid_item_from_webhook(uuid, text)
  from public, anon, authenticated;
revoke all on function public.revoke_plaid_account_from_webhook(uuid, text)
  from public, anon, authenticated;

grant execute on function public.create_plaid_item(uuid, text, text, text, text)
  to service_role;
grant execute on function public.claim_plaid_item_sync(uuid)
  to service_role;
grant execute on function public.apply_plaid_transaction_sync(
  uuid,
  text,
  jsonb,
  jsonb,
  text[],
  boolean,
  boolean
) to service_role;
grant execute on function public.record_plaid_item_sync_failure(uuid, text)
  to service_role;
grant execute on function public.get_plaid_item_token_for_user(uuid, uuid)
  to service_role;
grant execute on function public.disconnect_plaid_item(uuid, uuid)
  to service_role;
grant execute on function public.delete_disconnected_plaid_history(uuid, uuid)
  to service_role;
grant execute on function public.revoke_plaid_item_from_webhook(uuid, text)
  to service_role;
grant execute on function public.revoke_plaid_account_from_webhook(uuid, text)
  to service_role;
