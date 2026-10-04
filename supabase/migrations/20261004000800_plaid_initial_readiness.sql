create index plaid_overlap_candidates on public.transactions(owner_id,amount_cents,original_date) where not provider_removed;
create index plaid_record_transaction on app_private.plaid_records(transaction_id) where transaction_id is not null;
create index plaid_record_review on app_private.plaid_records(owner_id,state,id);

alter function public.plaid_admin(text,jsonb) rename to plaid_admin_selected;
revoke all on function public.plaid_admin_selected(text,jsonb) from public,anon,authenticated,service_role;
create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
declare c plaid_connections;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_action='await_data' then
    select * into c from plaid_connections where id=(p_payload->>'id')::uuid for update;
    if not found or c.lease is distinct from (p_payload->>'lease')::uuid or c.lease_until<now() or c.status<>'syncing' then raise exception 'Stale sync lease'; end if;
    update plaid_connections set lease=null,lease_until=null,due_at=now()+interval '15 seconds' where id=c.id;
    return null;
  end if;
  return public.plaid_admin_selected(p_action,p_payload);
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;
