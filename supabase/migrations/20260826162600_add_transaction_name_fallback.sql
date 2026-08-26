alter table public.transactions
  add column transaction_name text;

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
    transaction_name,
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
    updates.transaction_name,
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
    transaction_name text,
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
      transaction_name = excluded.transaction_name,
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

update public.plaid_items
set sync_cursor = null,
    initial_update_complete = false,
    historical_update_complete = false,
    status = 'initial_syncing',
    sync_started_at = null,
    updated_at = now()
where status <> 'disconnected';
