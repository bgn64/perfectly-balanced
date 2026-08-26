create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_transaction_id text not null,
  transaction_date date not null,
  merchant_name text,
  amount numeric not null,
  currency_code text check (
    currency_code is null or currency_code ~ '^[A-Z]{3}$'
  ),
  is_pending boolean not null,
  category text,
  account_name text not null,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, source_transaction_id)
);

create index transactions_user_date_idx
  on public.transactions (user_id, transaction_date desc);

alter table public.transactions enable row level security;

revoke all on table public.transactions from anon, authenticated;
grant select, delete on table public.transactions to authenticated;

create policy "Users can view their own transactions"
  on public.transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can delete their own transactions"
  on public.transactions
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.replace_transactions_for_user(
  p_user_id uuid,
  p_transactions jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'replace_transactions_for_user is restricted to the service role';
  end if;

  if jsonb_typeof(p_transactions) <> 'array' then
    raise exception 'p_transactions must be a JSON array';
  end if;

  delete from public.transactions
  where user_id = p_user_id;

  insert into public.transactions (
    user_id,
    source_transaction_id,
    transaction_date,
    merchant_name,
    amount,
    currency_code,
    is_pending,
    category,
    account_name
  )
  select
    p_user_id,
    imported.source_transaction_id,
    imported.transaction_date,
    imported.merchant_name,
    imported.amount,
    imported.currency_code,
    imported.is_pending,
    imported.category,
    imported.account_name
  from jsonb_to_recordset(p_transactions) as imported(
    source_transaction_id text,
    transaction_date date,
    merchant_name text,
    amount numeric,
    currency_code text,
    is_pending boolean,
    category text,
    account_name text
  );

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.replace_transactions_for_user(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_transactions_for_user(uuid, jsonb)
  to service_role;
