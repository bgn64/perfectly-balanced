create or replace function public.rename_budget_subsection(
  p_subsection_id uuid,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(p_name);
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Subsection name must contain between 1 and 100 characters';
  end if;

  update public.budget_subsections
  set name = v_name,
      updated_at = now()
  where id = p_subsection_id and user_id = v_user_id;

  if not found then
    raise exception 'Budget subsection was not found';
  end if;
end;
$$;

revoke all on function public.rename_budget_subsection(uuid, text)
  from public, anon, authenticated;

grant execute on function public.rename_budget_subsection(uuid, text)
  to authenticated;
