update public.transactions
set amount = -amount;

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
    -updates.amount,
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

alter table public.transactions
  add constraint transactions_id_user_id_key unique (id, user_id);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (
    name = btrim(name)
    and char_length(name) between 1 and 100
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create unique index categories_user_name_key
  on public.categories (user_id, lower(name));

create index categories_user_name_idx
  on public.categories (user_id, name);

create table public.transaction_category_splits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id uuid not null,
  category_id uuid not null,
  amount numeric not null check (amount <> 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transaction_category_splits_transaction_owner_fkey
    foreign key (transaction_id, user_id)
    references public.transactions (id, user_id)
    on delete cascade,
  constraint transaction_category_splits_category_owner_fkey
    foreign key (category_id, user_id)
    references public.categories (id, user_id),
  unique (transaction_id, category_id)
);

create index transaction_category_splits_user_id_idx
  on public.transaction_category_splits (user_id);

create index transaction_category_splits_category_id_idx
  on public.transaction_category_splits (category_id);

alter table public.categories enable row level security;
alter table public.transaction_category_splits enable row level security;

revoke all on table public.categories from anon, authenticated;
grant select, insert, update, delete on table public.categories to authenticated;

create policy "Users can view their own categories"
  on public.categories
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own categories"
  on public.categories
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own categories"
  on public.categories
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own categories"
  on public.categories
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.transaction_category_splits
  from anon, authenticated;
grant select on table public.transaction_category_splits to authenticated;

create policy "Users can view their own transaction category splits"
  on public.transaction_category_splits
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.replace_transaction_category_splits(
  p_transaction_id uuid,
  p_splits jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_transaction_amount numeric;
  v_split_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if jsonb_typeof(p_splits) <> 'array' then
    raise exception 'p_splits must be a JSON array';
  end if;

  select amount into v_transaction_amount
  from public.transactions
  where id = p_transaction_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Transaction was not found';
  end if;

  v_split_count := jsonb_array_length(p_splits);

  if v_split_count = 0 then
    delete from public.transaction_category_splits
    where transaction_id = p_transaction_id
      and user_id = v_user_id;
    return;
  end if;

  if v_transaction_amount = 0 then
    raise exception 'Zero-amount transactions cannot be split';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_splits) as split(
      category_id uuid,
      amount numeric
    )
    where split.category_id is null
      or split.amount is null
      or split.amount = 0
  ) then
    raise exception 'Every split requires a category and a nonzero amount';
  end if;

  if (
    select count(distinct split.category_id)
    from jsonb_to_recordset(p_splits) as split(
      category_id uuid,
      amount numeric
    )
  ) <> v_split_count then
    raise exception 'A category can appear only once in a transaction split';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_splits) as split(
      category_id uuid,
      amount numeric
    )
    left join public.categories as category
      on category.id = split.category_id
      and category.user_id = v_user_id
    where category.id is null
  ) then
    raise exception 'Every split category must belong to the current user';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_splits) as split(
      category_id uuid,
      amount numeric
    )
    where sign(split.amount) <> sign(v_transaction_amount)
  ) then
    raise exception 'Every split must have the same sign as the transaction';
  end if;

  if (
    select sum(split.amount)
    from jsonb_to_recordset(p_splits) as split(
      category_id uuid,
      amount numeric
    )
  ) <> v_transaction_amount then
    raise exception 'Splits must add up to the transaction amount';
  end if;

  delete from public.transaction_category_splits
  where transaction_id = p_transaction_id
    and user_id = v_user_id;

  insert into public.transaction_category_splits (
    user_id,
    transaction_id,
    category_id,
    amount
  )
  select
    v_user_id,
    p_transaction_id,
    split.category_id,
    split.amount
  from jsonb_to_recordset(p_splits) as split(
    category_id uuid,
    amount numeric
  );
end;
$$;

revoke all on function public.replace_transaction_category_splits(uuid, jsonb)
  from public, anon;
grant execute on function public.replace_transaction_category_splits(uuid, jsonb)
  to authenticated;

create or replace function public.clear_splits_after_transaction_amount_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.amount is distinct from old.amount then
    delete from public.transaction_category_splits
    where transaction_id = new.id;
  end if;

  return new;
end;
$$;

create trigger clear_splits_after_transaction_amount_change
after update of amount on public.transactions
for each row
execute function public.clear_splits_after_transaction_amount_change();
