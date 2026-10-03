create or replace function public.app_history(p_id uuid) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); target transactions;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select * into target from transactions where owner_id=uid and id=p_id;
  if not found then raise exception 'Transaction not found'; end if;
  return coalesce((select jsonb_agg(app_private.transaction_json(t)) from transactions t where owner_id=uid and id<>p_id and not excluded
    and ((trim(target.merchant)<>'' and trim(regexp_replace(lower(t.merchant),'[^a-z0-9]+',' ','g'))=trim(regexp_replace(lower(target.merchant),'[^a-z0-9]+',' ','g')))
      or trim(regexp_replace(lower(t.description),'[^a-z0-9]+',' ','g'))=trim(regexp_replace(lower(target.description),'[^a-z0-9]+',' ','g')))),'[]'::jsonb);
end $$;
