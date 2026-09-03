create or replace function public.copy_previous_month_budget(p_month date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_source_budget_id uuid;
  v_target_budget_id uuid;
  v_source_subsection record;
  v_target_subsection_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'Budget month must be the first day of a calendar month';
  end if;

  select id into v_source_budget_id
  from public.budgets
  where user_id = v_user_id
    and month = (p_month - interval '1 month')::date;

  if v_source_budget_id is null then
    raise exception 'Previous month budget was not found';
  end if;

  if exists (
    select 1
    from public.budgets
    where user_id = v_user_id and month = p_month
  ) then
    raise exception 'Budget for this month already exists';
  end if;

  insert into public.budgets (user_id, month)
  values (v_user_id, p_month)
  returning id into v_target_budget_id;

  insert into public.budget_category_allocations (
    user_id,
    budget_id,
    category_id,
    subsection_id,
    amount,
    direction,
    position
  )
  select
    v_user_id,
    v_target_budget_id,
    category_id,
    null,
    amount,
    direction,
    position
  from public.budget_category_allocations
  where budget_id = v_source_budget_id
    and user_id = v_user_id
    and subsection_id is null;

  for v_source_subsection in
    select id, name, position
    from public.budget_subsections
    where budget_id = v_source_budget_id and user_id = v_user_id
    order by position
  loop
    insert into public.budget_subsections (
      user_id,
      budget_id,
      name,
      position
    )
    values (
      v_user_id,
      v_target_budget_id,
      v_source_subsection.name,
      v_source_subsection.position
    )
    returning id into v_target_subsection_id;

    insert into public.budget_category_allocations (
      user_id,
      budget_id,
      category_id,
      subsection_id,
      amount,
      direction,
      position
    )
    select
      v_user_id,
      v_target_budget_id,
      category_id,
      v_target_subsection_id,
      amount,
      direction,
      position
    from public.budget_category_allocations
    where budget_id = v_source_budget_id
      and user_id = v_user_id
      and subsection_id = v_source_subsection.id;
  end loop;

  return v_target_budget_id;
end;
$$;

revoke all on function public.copy_previous_month_budget(date)
  from public, anon, authenticated;
grant execute on function public.copy_previous_month_budget(date)
  to authenticated;