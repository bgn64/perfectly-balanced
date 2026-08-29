create or replace function public.create_category_with_root_budget_allocation(
  p_budget_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(p_name);
  v_category_id uuid;
  v_position integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Category name must contain between 1 and 100 characters';
  end if;

  perform 1
  from public.budgets
  where id = p_budget_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget was not found';
  end if;

  insert into public.categories (user_id, name)
  values (v_user_id, v_name)
  returning id into v_category_id;

  select count(*) into v_position
  from public.budget_category_allocations
  where budget_id = p_budget_id and subsection_id is null;

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
    v_category_id,
    null,
    0,
    'spending',
    v_position
  );

  return jsonb_build_object('id', v_category_id, 'name', v_name);
end;
$$;

revoke all on function public.create_category_with_root_budget_allocation(
  uuid, text
) from public, anon, authenticated;

grant execute on function public.create_category_with_root_budget_allocation(
  uuid, text
) to authenticated;
