alter table public.budget_category_allocations
  add column direction text;

update public.budget_category_allocations
set direction = case when amount > 0 then 'income' else 'spending' end;

alter table public.budget_category_allocations
  alter column direction set not null,
  add constraint budget_category_allocations_direction_check
    check (direction in ('spending', 'income')),
  add constraint budget_category_allocations_amount_direction_check
    check (
      (direction = 'spending' and amount <= 0)
      or (direction = 'income' and amount >= 0)
    );

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

revoke all on table public.budget_category_activity from anon, authenticated;
grant select on table public.budget_category_activity to authenticated;

create or replace function public.create_budget_category_allocation(
  p_budget_id uuid,
  p_category_id uuid,
  p_subsection_id uuid,
  p_magnitude numeric,
  p_direction text
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

  if p_magnitude is null
    or p_magnitude < 0
    or p_magnitude <> trunc(p_magnitude, 2)
  then
    raise exception 'Budgeted magnitude must be nonnegative with no more than two decimal places';
  end if;

  if p_direction not in ('spending', 'income') then
    raise exception 'Direction must be spending or income';
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
    direction,
    position
  )
  values (
    v_user_id,
    p_budget_id,
    p_category_id,
    p_subsection_id,
    case when p_direction = 'spending' then -p_magnitude else p_magnitude end,
    p_direction,
    v_position
  )
  returning id into v_allocation_id;

  return v_allocation_id;
end;
$$;

create or replace function public.update_budget_category_allocation(
  p_allocation_id uuid,
  p_magnitude numeric,
  p_direction text
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

  if p_magnitude is null
    or p_magnitude < 0
    or p_magnitude <> trunc(p_magnitude, 2)
  then
    raise exception 'Budgeted magnitude must be nonnegative with no more than two decimal places';
  end if;

  if p_direction not in ('spending', 'income') then
    raise exception 'Direction must be spending or income';
  end if;

  update public.budget_category_allocations
  set amount = case
        when p_direction = 'spending' then -p_magnitude
        else p_magnitude
      end,
      direction = p_direction,
      updated_at = now()
  where id = p_allocation_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;
end;
$$;

create or replace function public.place_budget_subsection(
  p_subsection_id uuid,
  p_position integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
  v_current_position integer;
  v_count integer;
  v_offset integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id, position into v_budget_id, v_current_position
  from public.budget_subsections
  where id = p_subsection_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  perform 1
  from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select position into v_current_position
  from public.budget_subsections
  where id = p_subsection_id
    and budget_id = v_budget_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  select count(*) into v_count
  from public.budget_subsections
  where budget_id = v_budget_id and user_id = v_user_id;

  if p_position is null or p_position < 0 or p_position >= v_count then
    raise exception 'Subsection position is out of range';
  end if;

  if p_position = v_current_position then
    return;
  end if;

  v_offset := v_count + 1;

  update public.budget_subsections
  set position = position + v_offset
  where budget_id = v_budget_id and user_id = v_user_id;

  update public.budget_subsections
  set position = case
        when id = p_subsection_id then p_position
        when p_position < v_current_position
          and position - v_offset >= p_position
          and position - v_offset < v_current_position
          then position - v_offset + 1
        when p_position > v_current_position
          and position - v_offset > v_current_position
          and position - v_offset <= p_position
          then position - v_offset - 1
        else position - v_offset
      end,
      updated_at = now()
  where budget_id = v_budget_id and user_id = v_user_id;
end;
$$;

create or replace function public.place_budget_category_allocation(
  p_allocation_id uuid,
  p_subsection_id uuid,
  p_position integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_budget_id uuid;
  v_source_subsection_id uuid;
  v_current_position integer;
  v_target_count integer;
  v_total_count integer;
  v_offset integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id, subsection_id, position
  into v_budget_id, v_source_subsection_id, v_current_position
  from public.budget_category_allocations
  where id = p_allocation_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  perform 1
  from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select subsection_id, position
  into v_source_subsection_id, v_current_position
  from public.budget_category_allocations
  where id = p_allocation_id
    and budget_id = v_budget_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  if p_subsection_id is not null and not exists (
    select 1
    from public.budget_subsections
    where id = p_subsection_id
      and budget_id = v_budget_id
      and user_id = v_user_id
  ) then
    raise exception 'Budget subsection was not found';
  end if;

  select count(*) into v_target_count
  from public.budget_category_allocations
  where budget_id = v_budget_id
    and user_id = v_user_id
    and id <> p_allocation_id
    and subsection_id is not distinct from p_subsection_id;

  if p_position is null or p_position < 0 or p_position > v_target_count then
    raise exception 'Allocation position is out of range';
  end if;

  if p_subsection_id is not distinct from v_source_subsection_id
    and p_position = v_current_position
  then
    return;
  end if;

  select count(*) into v_total_count
  from public.budget_category_allocations
  where budget_id = v_budget_id and user_id = v_user_id;

  v_offset := v_total_count + 1;

  update public.budget_category_allocations
  set position = position + v_offset
  where budget_id = v_budget_id
    and user_id = v_user_id
    and (
      subsection_id is not distinct from v_source_subsection_id
      or subsection_id is not distinct from p_subsection_id
    );

  if p_subsection_id is not distinct from v_source_subsection_id then
    update public.budget_category_allocations
    set position = case
          when id = p_allocation_id then p_position
          when p_position < v_current_position
            and position - v_offset >= p_position
            and position - v_offset < v_current_position
            then position - v_offset + 1
          when p_position > v_current_position
            and position - v_offset > v_current_position
            and position - v_offset <= p_position
            then position - v_offset - 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is not distinct from v_source_subsection_id;
  else
    update public.budget_category_allocations
    set subsection_id = case
          when id = p_allocation_id then p_subsection_id
          else subsection_id
        end,
        position = case
          when id = p_allocation_id then p_position
          when subsection_id is not distinct from v_source_subsection_id
            and position - v_offset > v_current_position
            then position - v_offset - 1
          when subsection_id is not distinct from v_source_subsection_id
            then position - v_offset
          when subsection_id is not distinct from p_subsection_id
            and position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and (
        id = p_allocation_id
        or subsection_id is not distinct from v_source_subsection_id
        or subsection_id is not distinct from p_subsection_id
      );
  end if;
end;
$$;

revoke all on function public.create_budget_category_allocation(
  uuid, uuid, uuid, numeric, text
) from public, anon, authenticated;
revoke all on function public.update_budget_category_allocation(
  uuid, numeric, text
) from public, anon, authenticated;
revoke all on function public.place_budget_subsection(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.place_budget_category_allocation(
  uuid, uuid, integer
) from public, anon, authenticated;

grant execute on function public.create_budget_category_allocation(
  uuid, uuid, uuid, numeric, text
) to authenticated;
grant execute on function public.update_budget_category_allocation(
  uuid, numeric, text
) to authenticated;
grant execute on function public.place_budget_subsection(uuid, integer)
  to authenticated;
grant execute on function public.place_budget_category_allocation(
  uuid, uuid, integer
) to authenticated;

revoke all on function public.add_budget_category_allocation(
  uuid, uuid, uuid, numeric
) from public, anon, authenticated;
revoke all on function public.update_budget_allocation_amount(uuid, numeric)
  from public, anon, authenticated;
revoke all on function public.move_budget_subsection(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.move_budget_allocation(uuid, integer)
  from public, anon, authenticated;

drop function public.add_budget_category_allocation(uuid, uuid, uuid, numeric);
drop function public.update_budget_allocation_amount(uuid, numeric);
drop function public.move_budget_subsection(uuid, integer);
drop function public.move_budget_allocation(uuid, integer);
