create or replace function public.create_budget_category_allocation_at_position(
  p_budget_id uuid,
  p_category_id uuid,
  p_subsection_id uuid,
  p_position integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_position_count integer;
  v_offset integer;
  v_allocation_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
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

  if p_subsection_id is null then
    select
      (
        select count(*)
        from public.budget_category_allocations
        where budget_id = p_budget_id
          and user_id = v_user_id
          and subsection_id is null
      ) + (
        select count(*)
        from public.budget_subsections
        where budget_id = p_budget_id and user_id = v_user_id
      )
    into v_position_count;
  else
    select count(*) into v_position_count
    from public.budget_category_allocations
    where budget_id = p_budget_id
      and user_id = v_user_id
      and subsection_id = p_subsection_id;
  end if;

  if p_position is null
    or p_position < 0
    or p_position > v_position_count
  then
    raise exception 'Budget line item position is out of range';
  end if;

  v_offset := v_position_count + 1;

  if p_subsection_id is null then
    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = p_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = position + v_offset
    where budget_id = p_budget_id and user_id = v_user_id;

    update public.budget_category_allocations
    set position = case
          when position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = p_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = case
          when position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = p_budget_id and user_id = v_user_id;
  else
    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = p_budget_id
      and user_id = v_user_id
      and subsection_id = p_subsection_id;

    update public.budget_category_allocations
    set position = case
          when position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = p_budget_id
      and user_id = v_user_id
      and subsection_id = p_subsection_id;
  end if;

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
    0,
    'spending',
    p_position
  )
  returning id into v_allocation_id;

  return v_allocation_id;
end;
$$;

create or replace function public.create_budget_category_allocation_at_position(
  p_budget_id uuid,
  p_name text,
  p_subsection_id uuid,
  p_position integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(p_name);
  v_category_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Budget line item name must contain between 1 and 100 characters';
  end if;

  insert into public.categories (user_id, name)
  values (v_user_id, v_name)
  returning id into v_category_id;

  return public.create_budget_category_allocation_at_position(
    p_budget_id,
    v_category_id,
    p_subsection_id,
    p_position
  );
end;
$$;

revoke all on function public.create_budget_category_allocation_at_position(
  uuid, uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.create_budget_category_allocation_at_position(
  uuid, text, uuid, integer
) from public, anon, authenticated;

grant execute on function public.create_budget_category_allocation_at_position(
  uuid, uuid, uuid, integer
) to authenticated;
grant execute on function public.create_budget_category_allocation_at_position(
  uuid, text, uuid, integer
) to authenticated;