create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month),
  unique (id, user_id)
);

create table public.budget_subsections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  budget_id uuid not null,
  name text not null check (
    name = btrim(name)
    and char_length(name) between 1 and 100
  ),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_subsections_budget_owner_fkey
    foreign key (budget_id, user_id)
    references public.budgets (id, user_id)
    on delete cascade,
  unique (id, budget_id, user_id),
  unique (budget_id, position)
);

create unique index budget_subsections_budget_name_key
  on public.budget_subsections (budget_id, lower(name));

create table public.budget_category_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  budget_id uuid not null,
  category_id uuid not null,
  subsection_id uuid,
  amount numeric not null check (amount = trunc(amount, 2)),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_allocations_budget_owner_fkey
    foreign key (budget_id, user_id)
    references public.budgets (id, user_id)
    on delete cascade,
  constraint budget_allocations_category_owner_fkey
    foreign key (category_id, user_id)
    references public.categories (id, user_id),
  constraint budget_allocations_subsection_owner_fkey
    foreign key (subsection_id, budget_id, user_id)
    references public.budget_subsections (id, budget_id, user_id),
  unique (budget_id, category_id)
);

create unique index budget_allocations_subsection_position_key
  on public.budget_category_allocations (budget_id, subsection_id, position)
  where subsection_id is not null;

create unique index budget_allocations_root_position_key
  on public.budget_category_allocations (budget_id, position)
  where subsection_id is null;

create index budgets_user_month_idx on public.budgets (user_id, month);
create index budget_subsections_user_budget_idx
  on public.budget_subsections (user_id, budget_id, position);
create index budget_allocations_user_budget_idx
  on public.budget_category_allocations (
    user_id,
    budget_id,
    subsection_id,
    position
  );
create index transactions_user_date_currency_idx
  on public.transactions (user_id, transaction_date, currency_code);
create index transaction_splits_user_category_idx
  on public.transaction_category_splits (user_id, category_id, transaction_id);

alter table public.budgets enable row level security;
alter table public.budget_subsections enable row level security;
alter table public.budget_category_allocations enable row level security;

revoke all on table public.budgets from anon, authenticated;
revoke all on table public.budget_subsections from anon, authenticated;
revoke all on table public.budget_category_allocations from anon, authenticated;

grant select on table public.budgets to authenticated;
grant select on table public.budget_subsections to authenticated;
grant select on table public.budget_category_allocations to authenticated;

create policy "Users can view their own budgets"
  on public.budgets
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can view their own budget subsections"
  on public.budget_subsections
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can view their own budget allocations"
  on public.budget_category_allocations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.create_monthly_budget(p_month date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'Budget month must be the first day of a calendar month';
  end if;

  insert into public.budgets (user_id, month)
  values (v_user_id, p_month)
  returning id into v_budget_id;

  return v_budget_id;
end;
$$;

create or replace function public.add_budget_subsection(
  p_budget_id uuid,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(p_name);
  v_position integer;
  v_subsection_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Subsection name must contain between 1 and 100 characters';
  end if;

  perform 1
  from public.budgets
  where id = p_budget_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget was not found';
  end if;

  select count(*) into v_position
  from public.budget_subsections
  where budget_id = p_budget_id;

  insert into public.budget_subsections (
    user_id,
    budget_id,
    name,
    position
  )
  values (v_user_id, p_budget_id, v_name, v_position)
  returning id into v_subsection_id;

  return v_subsection_id;
end;
$$;

create or replace function public.add_budget_category_allocation(
  p_budget_id uuid,
  p_category_id uuid,
  p_subsection_id uuid,
  p_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_position integer;
  v_allocation_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_amount is null or p_amount <> trunc(p_amount, 2) then
    raise exception 'Budgeted amount must have no more than two decimal places';
  end if;

  perform 1
  from public.budgets
  where id = p_budget_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget was not found';
  end if;

  if not exists (
    select 1
    from public.categories
    where id = p_category_id and user_id = v_user_id
  ) then
    raise exception 'Category was not found';
  end if;

  if p_subsection_id is not null and not exists (
    select 1
    from public.budget_subsections
    where id = p_subsection_id
      and budget_id = p_budget_id
      and user_id = v_user_id
  ) then
    raise exception 'Budget subsection was not found';
  end if;

  select count(*) into v_position
  from public.budget_category_allocations
  where budget_id = p_budget_id
    and subsection_id is not distinct from p_subsection_id;

  insert into public.budget_category_allocations (
    user_id,
    budget_id,
    category_id,
    subsection_id,
    amount,
    position
  )
  values (
    v_user_id,
    p_budget_id,
    p_category_id,
    p_subsection_id,
    p_amount,
    v_position
  )
  returning id into v_allocation_id;

  return v_allocation_id;
end;
$$;

create or replace function public.update_budget_allocation_amount(
  p_allocation_id uuid,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_amount is null or p_amount <> trunc(p_amount, 2) then
    raise exception 'Budgeted amount must have no more than two decimal places';
  end if;

  update public.budget_category_allocations
  set amount = p_amount, updated_at = now()
  where id = p_allocation_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;
end;
$$;

create or replace function public.move_budget_subsection(
  p_subsection_id uuid,
  p_direction integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
  v_position integer;
  v_target_id uuid;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_direction not in (-1, 1) then
    raise exception 'Direction must be -1 or 1';
  end if;

  select budget_id into v_budget_id
  from public.budget_subsections
  where id = p_subsection_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  perform 1 from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select position into v_position
  from public.budget_subsections
  where id = p_subsection_id
    and budget_id = v_budget_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  select id into v_target_id
  from public.budget_subsections
  where budget_id = v_budget_id and position = v_position + p_direction;

  if v_target_id is null then
    return;
  end if;

  select count(*) into v_count
  from public.budget_subsections
  where budget_id = v_budget_id;

  update public.budget_subsections set position = v_count
  where id = v_target_id;
  update public.budget_subsections set position = v_position + p_direction
  where id = p_subsection_id;
  update public.budget_subsections set position = v_position
  where id = v_target_id;
end;
$$;

create or replace function public.move_budget_allocation(
  p_allocation_id uuid,
  p_direction integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
  v_subsection_id uuid;
  v_position integer;
  v_target_id uuid;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_direction not in (-1, 1) then
    raise exception 'Direction must be -1 or 1';
  end if;

  select budget_id into v_budget_id
  from public.budget_category_allocations
  where id = p_allocation_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  perform 1 from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select subsection_id, position into v_subsection_id, v_position
  from public.budget_category_allocations
  where id = p_allocation_id
    and budget_id = v_budget_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  select id into v_target_id
  from public.budget_category_allocations
  where budget_id = v_budget_id
    and subsection_id is not distinct from v_subsection_id
    and position = v_position + p_direction;

  if v_target_id is null then
    return;
  end if;

  select count(*) into v_count
  from public.budget_category_allocations
  where budget_id = v_budget_id
    and subsection_id is not distinct from v_subsection_id;

  update public.budget_category_allocations set position = v_count
  where id = v_target_id;
  update public.budget_category_allocations
  set position = v_position + p_direction
  where id = p_allocation_id;
  update public.budget_category_allocations set position = v_position
  where id = v_target_id;
end;
$$;

create or replace function public.remove_budget_allocation(p_allocation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
  v_subsection_id uuid;
  v_position integer;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id into v_budget_id
  from public.budget_category_allocations
  where id = p_allocation_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  perform 1 from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select subsection_id, position into v_subsection_id, v_position
  from public.budget_category_allocations
  where id = p_allocation_id
    and budget_id = v_budget_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  select count(*) into v_count
  from public.budget_category_allocations
  where budget_id = v_budget_id
    and subsection_id is not distinct from v_subsection_id;

  delete from public.budget_category_allocations
  where id = p_allocation_id;

  update public.budget_category_allocations
  set position = position + v_count
  where budget_id = v_budget_id
    and subsection_id is not distinct from v_subsection_id
    and position > v_position;

  update public.budget_category_allocations
  set position = position - v_count - 1
  where budget_id = v_budget_id
    and subsection_id is not distinct from v_subsection_id
    and position >= v_position + v_count;
end;
$$;

create or replace function public.delete_budget_subsection(p_subsection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
  v_position integer;
  v_root_count integer;
  v_subsection_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id into v_budget_id
  from public.budget_subsections
  where id = p_subsection_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  perform 1 from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select position into v_position
  from public.budget_subsections
  where id = p_subsection_id
    and budget_id = v_budget_id
    and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  select count(*) into v_root_count
  from public.budget_category_allocations
  where budget_id = v_budget_id and subsection_id is null;

  select count(*) into v_subsection_count
  from public.budget_subsections
  where budget_id = v_budget_id;

  update public.budget_category_allocations
  set subsection_id = null,
      position = v_root_count + position,
      updated_at = now()
  where budget_id = v_budget_id and subsection_id = p_subsection_id;

  delete from public.budget_subsections where id = p_subsection_id;

  update public.budget_subsections
  set position = position + v_subsection_count
  where budget_id = v_budget_id and position > v_position;

  update public.budget_subsections
  set position = position - v_subsection_count - 1
  where budget_id = v_budget_id
    and position >= v_position + v_subsection_count;
end;
$$;

create or replace view public.budget_category_activity
with (security_invoker = true)
as
select
  allocation.id as allocation_id,
  allocation.user_id,
  allocation.budget_id,
  allocation.category_id,
  category.name as category_name,
  allocation.subsection_id,
  subsection.name as subsection_name,
  subsection.position as subsection_position,
  allocation.position,
  allocation.amount as budgeted_amount,
  coalesce(sum(split.amount) filter (
    where tx.transaction_date >= budget.month
      and tx.transaction_date < budget.month + interval '1 month'
      and tx.currency_code = 'USD'
  ), 0) as actual_amount
from public.budget_category_allocations as allocation
join public.budgets as budget
  on budget.id = allocation.budget_id
  and budget.user_id = allocation.user_id
join public.categories as category
  on category.id = allocation.category_id
  and category.user_id = allocation.user_id
left join public.budget_subsections as subsection
  on subsection.id = allocation.subsection_id
  and subsection.budget_id = allocation.budget_id
  and subsection.user_id = allocation.user_id
left join public.transaction_category_splits as split
  on split.category_id = allocation.category_id
  and split.user_id = allocation.user_id
left join public.transactions as tx
  on tx.id = split.transaction_id
  and tx.user_id = split.user_id
group by
  allocation.id,
  allocation.user_id,
  allocation.budget_id,
  allocation.category_id,
  category.name,
  allocation.subsection_id,
  subsection.name,
  subsection.position,
  allocation.position,
  allocation.amount;

revoke all on table public.budget_category_activity from anon, authenticated;
grant select on table public.budget_category_activity to authenticated;

delete from public.transaction_category_splits as split
using public.transactions as tx
where tx.id = split.transaction_id
  and (
    tx.currency_code is null
    or tx.currency_code <> 'USD'
  );

create or replace function public.validate_usd_transaction_category_split()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.transactions
    where id = new.transaction_id
      and user_id = new.user_id
      and currency_code = 'USD'
  ) then
    raise exception 'Only USD transactions can be categorized';
  end if;

  return new;
end;
$$;

create trigger validate_usd_transaction_category_split
before insert or update on public.transaction_category_splits
for each row
execute function public.validate_usd_transaction_category_split();

create or replace function public.clear_splits_after_transaction_amount_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.amount is distinct from old.amount
    or (
      new.currency_code is distinct from old.currency_code
      and new.currency_code is distinct from 'USD'
    )
  then
    delete from public.transaction_category_splits
    where transaction_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger clear_splits_after_transaction_amount_change
  on public.transactions;

create trigger clear_splits_after_transaction_amount_change
after update of amount, currency_code on public.transactions
for each row
execute function public.clear_splits_after_transaction_amount_change();

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
  v_currency_code text;
  v_split_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if jsonb_typeof(p_splits) <> 'array' then
    raise exception 'p_splits must be a JSON array';
  end if;

  select amount, currency_code into v_transaction_amount, v_currency_code
  from public.transactions
  where id = p_transaction_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Transaction was not found';
  end if;

  v_split_count := jsonb_array_length(p_splits);

  if v_split_count = 0 then
    delete from public.transaction_category_splits
    where transaction_id = p_transaction_id and user_id = v_user_id;
    return;
  end if;

  if v_currency_code is distinct from 'USD' then
    raise exception 'Only USD transactions can be categorized';
  end if;

  if v_transaction_amount = 0 then
    raise exception 'Zero-amount transactions cannot be split';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_splits) as split(category_id uuid, amount numeric)
    where split.category_id is null
      or split.amount is null
      or split.amount = 0
  ) then
    raise exception 'Every split requires a category and a nonzero amount';
  end if;

  if (
    select count(distinct split.category_id)
    from jsonb_to_recordset(p_splits) as split(category_id uuid, amount numeric)
  ) <> v_split_count then
    raise exception 'A category can appear only once in a transaction split';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_splits) as split(category_id uuid, amount numeric)
    left join public.categories as category
      on category.id = split.category_id and category.user_id = v_user_id
    where category.id is null
  ) then
    raise exception 'Every split category must belong to the current user';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_splits) as split(category_id uuid, amount numeric)
    where sign(split.amount) <> sign(v_transaction_amount)
  ) then
    raise exception 'Every split must have the same sign as the transaction';
  end if;

  if (
    select sum(split.amount)
    from jsonb_to_recordset(p_splits) as split(category_id uuid, amount numeric)
  ) <> v_transaction_amount then
    raise exception 'Splits must add up to the transaction amount';
  end if;

  delete from public.transaction_category_splits
  where transaction_id = p_transaction_id and user_id = v_user_id;

  insert into public.transaction_category_splits (
    user_id,
    transaction_id,
    category_id,
    amount
  )
  select v_user_id, p_transaction_id, split.category_id, split.amount
  from jsonb_to_recordset(p_splits) as split(category_id uuid, amount numeric);
end;
$$;

revoke all on function public.create_monthly_budget(date)
  from public, anon;
revoke all on function public.add_budget_subsection(uuid, text)
  from public, anon;
revoke all on function public.add_budget_category_allocation(
  uuid, uuid, uuid, numeric
) from public, anon;
revoke all on function public.update_budget_allocation_amount(uuid, numeric)
  from public, anon;
revoke all on function public.move_budget_subsection(uuid, integer)
  from public, anon;
revoke all on function public.move_budget_allocation(uuid, integer)
  from public, anon;
revoke all on function public.remove_budget_allocation(uuid)
  from public, anon;
revoke all on function public.delete_budget_subsection(uuid)
  from public, anon;

grant execute on function public.create_monthly_budget(date)
  to authenticated;
grant execute on function public.add_budget_subsection(uuid, text)
  to authenticated;
grant execute on function public.add_budget_category_allocation(
  uuid, uuid, uuid, numeric
) to authenticated;
grant execute on function public.update_budget_allocation_amount(uuid, numeric)
  to authenticated;
grant execute on function public.move_budget_subsection(uuid, integer)
  to authenticated;
grant execute on function public.move_budget_allocation(uuid, integer)
  to authenticated;
grant execute on function public.remove_budget_allocation(uuid)
  to authenticated;
grant execute on function public.delete_budget_subsection(uuid)
  to authenticated;
