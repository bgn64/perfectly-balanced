alter function public.plaid_admin(text,jsonb) rename to plaid_admin_hardened;
revoke all on function public.plaid_admin_hardened(text,jsonb) from public,anon,authenticated,service_role;
create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_action='claim' then
    update plaid_connections set due_at=now() where environment=p_payload->>'environment'
      and status='active' and not historical_complete and connected_at>now()-interval '1 hour'
      and last_synced_at<now()-interval '1 minute' and due_at is null and lease is null;
  end if;
  return public.plaid_admin_hardened(p_action,p_payload);
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;

create function public.app_bank_restore(p_id uuid,p_revision bigint) returns void language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); t public.transactions;
begin
  select * into t from public.transactions where owner_id=uid and id=p_id and provider_removed for update;
  if not found or t.revision<>p_revision then raise exception 'Removed transaction changed or is unavailable; refresh'; end if;
  update public.transactions set provider_removed=false where id=t.id;
  update plaid_records set state='ignored',reason=null where owner_id=uid and transaction_id=t.id and removed;
  insert into plaid_audit(owner_id,decision,before_value,after_value)
    values(uid,'restore',app_private.transaction_json(t),jsonb_build_object('transaction_id',t.id,'provider_removed',false));
end $$;
revoke all on function public.app_bank_restore(uuid,bigint) from public,anon;
grant execute on function public.app_bank_restore(uuid,bigint) to authenticated;
