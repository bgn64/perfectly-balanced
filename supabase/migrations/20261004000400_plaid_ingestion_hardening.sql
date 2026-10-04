revoke all on net.http_request_queue,net._http_response from public,anon,authenticated;
revoke all on vault.secrets,vault.decrypted_secrets from public,anon,authenticated;

alter table app_private.plaid_connections add column initial_complete boolean not null default false;
alter table app_private.plaid_connections add column historical_complete boolean not null default false;

alter function public.plaid_admin(text,jsonb) rename to plaid_admin_guarded;
revoke all on function public.plaid_admin_guarded(text,jsonb) from public,anon,authenticated,service_role;
create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
declare c plaid_connections; result jsonb; cid uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_action='find_item' then
    select id into cid from plaid_connections where item_id=p_payload->>'item_id' and owner_id=(p_payload->>'owner_id')::uuid;
    return to_jsonb(cid);
  end if;
  if p_action='webhook' then
    select * into c from plaid_connections where item_id=p_payload->>'item_id' for update;
    if found and c.status not in ('disconnected','disconnecting') then
      update plaid_connections set initial_complete=initial_complete or coalesce((p_payload->>'initial_complete')::boolean,false),
        historical_complete=historical_complete or coalesce((p_payload->>'historical_complete')::boolean,false) where id=c.id;
    end if;
  end if;
  if p_action='stage' then
    cid:=(p_payload->>'id')::uuid;
    select * into c from plaid_connections where id=cid;
    perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text,0));
    select * into c from plaid_connections where id=cid for update;
    if c.lease is distinct from (p_payload->>'lease')::uuid or c.lease_until<now() then raise exception 'Stale sync lease'; end if;
    update plaid_records r set state='new' where r.connection_id=cid and r.state='ignored' and r.transaction_id is not null
      and exists(select 1 from jsonb_array_elements(p_payload->'changes') x where x->>'source_id'=r.source_id
        and (nullif(x->'value','null'::jsonb) is distinct from r.value or (x->>'removed')::boolean is distinct from r.removed));
  end if;
  result:=public.plaid_admin_guarded(p_action,p_payload);
  return result;
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;

alter function public.app_banking(integer) rename to app_banking_versioned;
revoke all on function public.app_banking_versioned(integer) from public,anon,authenticated,service_role;
create function public.app_banking(p_offset integer default 0) returns jsonb language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
declare result jsonb; connections jsonb:='[]'; x jsonb; c plaid_connections;
begin
  result:=public.app_banking_versioned(p_offset);
  for x in select value from jsonb_array_elements(result->'connections') loop
    select * into c from plaid_connections where owner_id=auth.uid() and id=(x->>'id')::uuid;
    connections:=connections || jsonb_build_array(x || jsonb_build_object('initial_complete',c.initial_complete,'historical_complete',c.historical_complete));
  end loop;
  return jsonb_set(result,'{connections}',connections);
end $$;
revoke all on function public.app_banking(integer) from public,anon;
grant execute on function public.app_banking(integer) to authenticated;
