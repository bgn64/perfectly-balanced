alter table public.transactions
  add column is_ignored boolean not null default false;

create or replace function public.set_transaction_ignored(
  p_transaction_id uuid,
  p_is_ignored boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_ignored boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_is_ignored is null then
    raise exception 'Transaction ignored state is required';
  end if;

  update public.transactions
  set is_ignored = p_is_ignored
  where id = p_transaction_id and user_id = v_user_id
  returning is_ignored into v_is_ignored;

  if not found then
    raise exception 'Transaction was not found';
  end if;

  return v_is_ignored;
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

revoke all on function public.set_transaction_ignored(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_transaction_ignored(uuid, boolean)
  to authenticated;

revoke all on table public.budget_category_activity from anon, authenticated;
grant select on table public.budget_category_activity to authenticated;