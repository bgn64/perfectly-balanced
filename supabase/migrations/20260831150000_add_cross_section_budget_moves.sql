do $$
declare
  v_budget record;
  v_root_count integer;
  v_subsection_count integer;
  v_offset integer;
begin
  lock table public.budgets in access exclusive mode;

  for v_budget in
    select id, user_id
    from public.budgets
  loop
    select count(*) into v_root_count
    from public.budget_category_allocations
    where budget_id = v_budget.id
      and user_id = v_budget.user_id
      and subsection_id is null;

    select count(*) into v_subsection_count
    from public.budget_subsections
    where budget_id = v_budget.id and user_id = v_budget.user_id;

    v_offset := v_root_count + v_subsection_count + 1;

    update public.budget_subsections
    set position = position + v_offset
    where budget_id = v_budget.id and user_id = v_budget.user_id;

    update public.budget_subsections
    set position = position - v_offset + v_root_count,
        updated_at = now()
    where budget_id = v_budget.id and user_id = v_budget.user_id;
  end loop;
end;
$$;

create or replace function public.create_budget_subsection_at_position(
  p_budget_id uuid,
  p_name text,
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
  v_top_level_count integer;
  v_offset integer;
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
  into v_top_level_count;

  if p_position is null
    or p_position < 0
    or p_position > v_top_level_count
  then
    raise exception 'Subsection position is out of range';
  end if;

  v_offset := v_top_level_count + 1;

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

  insert into public.budget_subsections (
    user_id,
    budget_id,
    name,
    position
  )
  values (v_user_id, p_budget_id, v_name, p_position)
  returning id into v_subsection_id;

  return v_subsection_id;
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
  v_position_count integer;
  v_offset integer;
  v_category_id uuid;
  v_allocation_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Budget line item name must contain between 1 and 100 characters';
  end if;

  perform 1
  from public.budgets
  where id = p_budget_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget was not found';
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

  insert into public.categories (user_id, name)
  values (v_user_id, v_name)
  returning id into v_category_id;

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
    p_subsection_id,
    0,
    'spending',
    p_position
  )
  returning id into v_allocation_id;

  return v_allocation_id;
end;
$$;

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
    into v_position;
  else
    select count(*) into v_position
    from public.budget_category_allocations
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
    case when p_direction = 'spending' then -p_magnitude else p_magnitude end,
    p_direction,
    v_position
  )
  returning id into v_allocation_id;

  return v_allocation_id;
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
  v_top_level_count integer;
  v_offset integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id, position
  into v_budget_id, v_current_position
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

  select
    (
      select count(*)
      from public.budget_category_allocations
      where budget_id = v_budget_id
        and user_id = v_user_id
        and subsection_id is null
    ) + (
      select count(*)
      from public.budget_subsections
      where budget_id = v_budget_id and user_id = v_user_id
    )
  into v_top_level_count;

  if p_position is null
    or p_position < 0
    or p_position >= v_top_level_count
  then
    raise exception 'Subsection position is out of range';
  end if;

  if p_position = v_current_position then
    return;
  end if;

  v_offset := v_top_level_count + 1;

  update public.budget_category_allocations
  set position = position + v_offset
  where budget_id = v_budget_id
    and user_id = v_user_id
    and subsection_id is null;

  update public.budget_subsections
  set position = position + v_offset
  where budget_id = v_budget_id and user_id = v_user_id;

  update public.budget_category_allocations
  set position = case
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
    and subsection_id is null;

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
  v_source_count integer;
  v_target_count integer;
  v_top_level_count integer;
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

  if v_source_subsection_id is null and p_subsection_id is null then
    select
      (
        select count(*)
        from public.budget_category_allocations
        where budget_id = v_budget_id
          and user_id = v_user_id
          and subsection_id is null
      ) + (
        select count(*)
        from public.budget_subsections
        where budget_id = v_budget_id and user_id = v_user_id
      )
    into v_top_level_count;

    if p_position is null
      or p_position < 0
      or p_position >= v_top_level_count
    then
      raise exception 'Budget line item position is out of range';
    end if;

    if p_position = v_current_position then
      return;
    end if;

    v_offset := v_top_level_count + 1;

    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = position + v_offset
    where budget_id = v_budget_id and user_id = v_user_id;

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
      and subsection_id is null;

    update public.budget_subsections
    set position = case
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

    return;
  end if;

  if v_source_subsection_id is null then
    select count(*) into v_target_count
    from public.budget_category_allocations
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = p_subsection_id;

    if p_position is null
      or p_position < 0
      or p_position > v_target_count
    then
      raise exception 'Budget line item position is out of range';
    end if;

    select
      (
        select count(*)
        from public.budget_category_allocations
        where budget_id = v_budget_id
          and user_id = v_user_id
          and subsection_id is null
      ) + (
        select count(*)
        from public.budget_subsections
        where budget_id = v_budget_id and user_id = v_user_id
      )
    into v_top_level_count;
    v_offset := v_top_level_count + 1;

    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = position + v_offset
    where budget_id = v_budget_id and user_id = v_user_id;

    update public.budget_category_allocations
    set position = case
          when id = p_allocation_id then position
          when position - v_offset > v_current_position
            then position - v_offset - 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = case
          when position - v_offset > v_current_position
            then position - v_offset - 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id and user_id = v_user_id;

    v_offset := v_target_count + 1;

    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = p_subsection_id;

    update public.budget_category_allocations
    set position = case
          when position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = p_subsection_id;

    update public.budget_category_allocations
    set subsection_id = p_subsection_id,
        position = p_position,
        updated_at = now()
    where id = p_allocation_id and user_id = v_user_id;

    return;
  end if;

  if p_subsection_id is null then
    select count(*) into v_source_count
    from public.budget_category_allocations
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = v_source_subsection_id;
    v_offset := v_source_count + 1;

    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = v_source_subsection_id;

    update public.budget_category_allocations
    set position = case
          when id = p_allocation_id then position
          when position - v_offset > v_current_position
            then position - v_offset - 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = v_source_subsection_id;

    select
      (
        select count(*)
        from public.budget_category_allocations
        where budget_id = v_budget_id
          and user_id = v_user_id
          and subsection_id is null
      ) + (
        select count(*)
        from public.budget_subsections
        where budget_id = v_budget_id and user_id = v_user_id
      )
    into v_top_level_count;

    if p_position is null
      or p_position < 0
      or p_position > v_top_level_count
    then
      raise exception 'Budget line item position is out of range';
    end if;

    v_offset := v_top_level_count + 1;

    update public.budget_category_allocations
    set position = position + v_offset
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = position + v_offset
    where budget_id = v_budget_id and user_id = v_user_id;

    update public.budget_category_allocations
    set position = case
          when position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null;

    update public.budget_subsections
    set position = case
          when position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id and user_id = v_user_id;

    update public.budget_category_allocations
    set subsection_id = null,
        position = p_position,
        updated_at = now()
    where id = p_allocation_id and user_id = v_user_id;

    return;
  end if;

  select count(*) into v_target_count
  from public.budget_category_allocations
  where budget_id = v_budget_id
    and user_id = v_user_id
    and subsection_id = p_subsection_id
    and id <> p_allocation_id;

  if p_position is null
    or p_position < 0
    or p_position > v_target_count
  then
    raise exception 'Budget line item position is out of range';
  end if;

  if p_subsection_id = v_source_subsection_id
    and p_position = v_current_position
  then
    return;
  end if;

  select count(*) + 1 into v_offset
  from public.budget_category_allocations
  where budget_id = v_budget_id and user_id = v_user_id;

  update public.budget_category_allocations
  set position = position + v_offset
  where budget_id = v_budget_id
    and user_id = v_user_id
    and (
      subsection_id = v_source_subsection_id
      or subsection_id = p_subsection_id
    );

  if p_subsection_id = v_source_subsection_id then
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
      and subsection_id = v_source_subsection_id;
  else
    update public.budget_category_allocations
    set subsection_id = case
          when id = p_allocation_id then p_subsection_id
          else subsection_id
        end,
        position = case
          when id = p_allocation_id then p_position
          when subsection_id = v_source_subsection_id
            and position - v_offset > v_current_position
            then position - v_offset - 1
          when subsection_id = v_source_subsection_id
            then position - v_offset
          when subsection_id = p_subsection_id
            and position - v_offset >= p_position
            then position - v_offset + 1
          else position - v_offset
        end,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and (
        id = p_allocation_id
        or subsection_id = v_source_subsection_id
        or subsection_id = p_subsection_id
      );
  end if;
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
  v_position_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id, subsection_id, position
  into v_budget_id, v_subsection_id, v_position
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
  into v_subsection_id, v_position
  from public.budget_category_allocations
  where id = p_allocation_id
    and budget_id = v_budget_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget allocation was not found';
  end if;

  if v_subsection_id is null then
    select
      (
        select count(*)
        from public.budget_category_allocations
        where budget_id = v_budget_id
          and user_id = v_user_id
          and subsection_id is null
      ) + (
        select count(*)
        from public.budget_subsections
        where budget_id = v_budget_id and user_id = v_user_id
      )
    into v_position_count;

    delete from public.budget_category_allocations
    where id = p_allocation_id and user_id = v_user_id;

    update public.budget_category_allocations
    set position = position + v_position_count
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null
      and position > v_position;

    update public.budget_subsections
    set position = position + v_position_count
    where budget_id = v_budget_id
      and user_id = v_user_id
      and position > v_position;

    update public.budget_category_allocations
    set position = position - v_position_count - 1,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id is null
      and position >= v_position + v_position_count;

    update public.budget_subsections
    set position = position - v_position_count - 1,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and position >= v_position + v_position_count;
  else
    select count(*) into v_position_count
    from public.budget_category_allocations
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = v_subsection_id;

    delete from public.budget_category_allocations
    where id = p_allocation_id and user_id = v_user_id;

    update public.budget_category_allocations
    set position = position + v_position_count
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = v_subsection_id
      and position > v_position;

    update public.budget_category_allocations
    set position = position - v_position_count - 1,
        updated_at = now()
    where budget_id = v_budget_id
      and user_id = v_user_id
      and subsection_id = v_subsection_id
      and position >= v_position + v_position_count;
  end if;
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
  v_top_level_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select budget_id, position
  into v_budget_id, v_position
  from public.budget_subsections
  where id = p_subsection_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  perform 1
  from public.budgets
  where id = v_budget_id and user_id = v_user_id
  for update;

  select position into v_position
  from public.budget_subsections
  where id = p_subsection_id
    and budget_id = v_budget_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;

  select
    (
      select count(*)
      from public.budget_category_allocations
      where budget_id = v_budget_id
        and user_id = v_user_id
        and subsection_id is null
    ) + (
      select count(*)
      from public.budget_subsections
      where budget_id = v_budget_id and user_id = v_user_id
    )
  into v_top_level_count;

  delete from public.budget_category_allocations
  where budget_id = v_budget_id
    and user_id = v_user_id
    and subsection_id = p_subsection_id;

  delete from public.budget_subsections
  where id = p_subsection_id and user_id = v_user_id;

  update public.budget_category_allocations
  set position = position + v_top_level_count
  where budget_id = v_budget_id
    and user_id = v_user_id
    and subsection_id is null
    and position > v_position;

  update public.budget_subsections
  set position = position + v_top_level_count
  where budget_id = v_budget_id
    and user_id = v_user_id
    and position > v_position;

  update public.budget_category_allocations
  set position = position - v_top_level_count - 1,
      updated_at = now()
  where budget_id = v_budget_id
    and user_id = v_user_id
    and subsection_id is null
    and position >= v_position + v_top_level_count;

  update public.budget_subsections
  set position = position - v_top_level_count - 1,
      updated_at = now()
  where budget_id = v_budget_id
    and user_id = v_user_id
    and position >= v_position + v_top_level_count;
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
  v_position integer;
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
  into v_position;

  return public.create_budget_subsection_at_position(
    p_budget_id,
    p_name,
    v_position
  );
end;
$$;

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
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Category name must contain between 1 and 100 characters';
  end if;

  insert into public.categories (user_id, name)
  values (v_user_id, v_name)
  returning id into v_category_id;

  perform public.create_budget_category_allocation(
    p_budget_id,
    v_category_id,
    null,
    0,
    'spending'
  );

  return jsonb_build_object('id', v_category_id, 'name', v_name);
end;
$$;

revoke all on function public.create_budget_subsection_at_position(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.create_budget_category_allocation_at_position(
  uuid, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.create_budget_category_allocation(
  uuid, uuid, uuid, numeric, text
) from public, anon, authenticated;
revoke all on function public.place_budget_subsection(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.place_budget_category_allocation(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.remove_budget_allocation(uuid)
  from public, anon, authenticated;
revoke all on function public.delete_budget_subsection(uuid)
  from public, anon, authenticated;

grant execute on function public.create_budget_subsection_at_position(uuid, text, integer)
  to authenticated;
grant execute on function public.create_budget_category_allocation_at_position(
  uuid, text, uuid, integer
) to authenticated;
grant execute on function public.create_budget_category_allocation(
  uuid, uuid, uuid, numeric, text
) to authenticated;
grant execute on function public.place_budget_subsection(uuid, integer)
  to authenticated;
grant execute on function public.place_budget_category_allocation(
  uuid, uuid, integer
) to authenticated;
grant execute on function public.remove_budget_allocation(uuid)
  to authenticated;
grant execute on function public.delete_budget_subsection(uuid)
  to authenticated;
