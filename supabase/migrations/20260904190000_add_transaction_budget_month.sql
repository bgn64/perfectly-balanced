alter table public.transactions
  add column budget_month_override date,
  add column effective_budget_month date generated always as (
    coalesce(
      budget_month_override,
      make_date(
        extract(year from transaction_date)::integer,
        extract(month from transaction_date)::integer,
        1
      )
    )
  ) stored,
  add constraint transactions_budget_month_override_first_day_check check (
    budget_month_override is null
    or budget_month_override = make_date(
      extract(year from budget_month_override)::integer,
      extract(month from budget_month_override)::integer,
      1
    )
  );

create index transactions_user_effective_budget_month_idx
  on public.transactions (user_id, effective_budget_month, id);

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
    where tx.effective_budget_month = budget.month
      and tx.currency_code = 'USD'
      and not tx.is_ignored
  ), 0) as actual_amount,
  allocation.direction
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
  allocation.direction,
  allocation.amount;

create or replace function public.update_transaction_budgeting(
  p_transaction_id uuid,
  p_splits jsonb,
  p_budget_month_override date,
  p_is_ignored boolean
)
returns table (
  budget_month_override date,
  effective_budget_month date,
  is_ignored boolean
)
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

  if p_is_ignored is null then
    raise exception 'Transaction ignored state is required';
  end if;

  if p_budget_month_override is not null
    and p_budget_month_override <> make_date(
      extract(year from p_budget_month_override)::integer,
      extract(month from p_budget_month_override)::integer,
      1
    )
  then
    raise exception 'Budget month must be the first day of a calendar month';
  end if;

  select amount, currency_code
  into v_transaction_amount, v_currency_code
  from public.transactions
  where id = p_transaction_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Transaction was not found';
  end if;

  v_split_count := jsonb_array_length(p_splits);

  if v_currency_code is distinct from 'USD'
    and (v_split_count > 0 or p_budget_month_override is not null)
  then
    raise exception 'Only USD transactions can be categorized or assigned to a budget month';
  end if;

  if v_split_count > 0 then
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
  end if;

  update public.transactions
  set budget_month_override = p_budget_month_override,
      is_ignored = p_is_ignored
  where id = p_transaction_id and user_id = v_user_id;

  delete from public.transaction_category_splits
  where transaction_id = p_transaction_id and user_id = v_user_id;

  if v_split_count > 0 then
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
  end if;

  return query
  select
    tx.budget_month_override,
    tx.effective_budget_month,
    tx.is_ignored
  from public.transactions as tx
  where tx.id = p_transaction_id and tx.user_id = v_user_id;
end;
$$;

revoke all on function public.update_transaction_budgeting(
  uuid, jsonb, date, boolean
) from public, anon;
grant execute on function public.update_transaction_budgeting(
  uuid, jsonb, date, boolean
) to authenticated;

revoke all on table public.budget_category_activity from anon, authenticated;
grant select on table public.budget_category_activity to authenticated;