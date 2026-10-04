alter function public.plaid_admin(text,jsonb) rename to plaid_admin_internal;
revoke all on function public.plaid_admin_internal(text,jsonb) from public,anon,authenticated,service_role;

create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare c plaid_connections; uid uuid; cid uuid; a jsonb; result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  cid:=(p_payload->>'id')::uuid; uid:=(p_payload->>'owner_id')::uuid;
  if cid is not null then
    select * into c from plaid_connections where id=cid and (uid is null or owner_id=uid);
    if not found then raise exception 'Connection not found'; end if;
    perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text,0));
    select * into c from plaid_connections where id=cid for update;
  end if;
  if p_action='accounts_snapshot' then
    if c.status in ('disconnected','disconnecting') or
      (p_payload->>'lease' is not null and (c.lease is distinct from (p_payload->>'lease')::uuid or c.lease_until<now())) then
      raise exception 'Stale account snapshot';
    end if;
    update plaid_accounts set type='unavailable',selected=false where connection_id=cid
      and account_id not in(select value->>'account_id' from jsonb_array_elements(p_payload->'accounts'));
    for a in select value from jsonb_array_elements(p_payload->'accounts') loop
      insert into plaid_accounts(connection_id,account_id,name,mask,type,subtype)
        values(cid,a->>'account_id',a->>'name',a->>'mask',a->>'type',a->>'subtype')
        on conflict(connection_id,account_id) do update set name=excluded.name,mask=excluded.mask,type=excluded.type,subtype=excluded.subtype;
    end loop;
    return null;
  end if;
  if p_action='failure' and p_payload->>'error_code'='ITEM_LOGIN_REQUIRED' then
    delete from plaid_staging where connection_id=cid;
    update plaid_connections set page_cursor=null,claimed_at=null where id=cid;
  end if;
  if p_action='stage' and not (p_payload->>'has_more')::boolean then
    update plaid_records r set state='new' where r.connection_id=cid and r.state='ignored' and r.transaction_id is not null
      and exists(select 1 from jsonb_array_elements(p_payload->'changes') x
        where x->>'source_id'=r.source_id and (nullif(x->'value','null'::jsonb) is distinct from r.value or (x->>'removed')::boolean is distinct from r.removed));
  end if;
  result:=public.plaid_admin_internal(p_action,p_payload);
  return result;
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create function public.plaid_schedule(p_url text,p_worker_secret text) returns void
language plpgsql security definer set search_path=public,app_private,vault,pg_temp as $$
declare job bigint; sid uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/plaid-worker$'
    and p_url<>'http://kong:8000/functions/v1/plaid-worker' then raise exception 'Invalid worker URL'; end if;
  if length(p_worker_secret)<32 then raise exception 'Worker secret must have at least 32 characters'; end if;
  select id into sid from vault.secrets where name='plaid_worker_url';
  if sid is null then perform vault.create_secret(p_url,'plaid_worker_url');
  else perform vault.update_secret(sid,p_url); end if;
  select id into sid from vault.secrets where name='plaid_worker_secret';
  if sid is null then perform vault.create_secret(p_worker_secret,'plaid_worker_secret');
  else perform vault.update_secret(sid,p_worker_secret); end if;
  select jobid into job from cron.job where jobname='plaid-sync-worker';
  if job is not null then perform cron.unschedule(job); end if;
  perform cron.schedule('plaid-sync-worker','* * * * *',$job$
    select net.http_post(
      url:=(select decrypted_secret from vault.decrypted_secrets where name='plaid_worker_url'),
      headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',
        (select decrypted_secret from vault.decrypted_secrets where name='plaid_worker_secret')),
      body:='{}'::jsonb,timeout_milliseconds:=55000);
  $job$);
end $$;
revoke all on function public.plaid_schedule(text,text) from public,anon,authenticated;
grant execute on function public.plaid_schedule(text,text) to service_role;
