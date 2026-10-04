alter function public.plaid_admin(text,jsonb) rename to plaid_admin_catchup;
revoke all on function public.plaid_admin_catchup(text,jsonb) from public,anon,authenticated,service_role;
create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer
set search_path=public,app_private,vault,pg_temp as $$
declare c plaid_connections; lease_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_action='claim' and p_payload->>'id' is not null then
    select * into c from plaid_connections where id=(p_payload->>'id')::uuid
      and environment=p_payload->>'environment' and status in ('active','syncing','error')
      and attempts<8 and (lease_until is null or lease_until<now()) and due_at<=now() for update skip locked;
    if not found then return null; end if;
    lease_id:=gen_random_uuid();
    update plaid_connections set lease=lease_id,lease_until=now()+interval '2 minutes',
      claimed_at=coalesce(claimed_at,now()),status='syncing' where id=c.id;
    return jsonb_build_object('id',c.id,'lease',lease_id,'cursor',coalesce(c.page_cursor,c.cursor),
      'access_token',(select decrypted_secret from vault.decrypted_secrets where id=c.secret_id));
  end if;
  return public.plaid_admin_catchup(p_action,p_payload);
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;
