create table app_private.plaid_worker_receipts(
  nonce uuid primary key,
  received_at timestamptz not null default now()
);
revoke all on app_private.plaid_worker_receipts from public,anon,authenticated;
create function public.plaid_worker_receipt(p_nonce uuid) returns boolean language plpgsql security definer
set search_path=app_private,pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  delete from plaid_worker_receipts where received_at<now()-interval '3 minutes';
  insert into plaid_worker_receipts(nonce) values(p_nonce) on conflict do nothing;
  return found;
end $$;
revoke all on function public.plaid_worker_receipt(uuid) from public,anon,authenticated;
grant execute on function public.plaid_worker_receipt(uuid) to service_role;

create function app_private.plaid_dispatch() returns bigint language plpgsql security definer
set search_path=app_private,vault,extensions,pg_temp as $$
declare u text; secret text; payload jsonb; signature text;
begin
  select decrypted_secret into u from vault.decrypted_secrets where name='plaid_worker_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name='plaid_worker_secret';
  if u is null or secret is null then raise exception 'Plaid scheduler configuration missing'; end if;
  payload:=jsonb_build_object('issued_at',floor(extract(epoch from clock_timestamp()))::bigint,'nonce',gen_random_uuid(),
    'environment',case when u='http://kong:8000/functions/v1/plaid-worker' then 'sandbox' else 'production' end);
  signature:=encode(extensions.hmac(convert_to(payload::text,'UTF8'),convert_to(secret,'UTF8'),'sha256'),'hex');
  return net.http_post(url:=u,headers:=jsonb_build_object('Content-Type','application/json','x-worker-signature',signature),
    body:=payload,timeout_milliseconds:=55000);
end $$;
revoke all on function app_private.plaid_dispatch() from public,anon,authenticated,service_role;

create or replace function public.plaid_schedule(p_url text,p_worker_secret text) returns void language plpgsql security definer
set search_path=public,app_private,vault,pg_temp as $$
declare job bigint; sid uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/plaid-worker$'
    and p_url<>'http://kong:8000/functions/v1/plaid-worker' then raise exception 'Invalid worker URL'; end if;
  if length(p_worker_secret)<32 then raise exception 'Worker secret must have at least 32 characters'; end if;
  select id into sid from vault.secrets where name='plaid_worker_url';
  if sid is null then perform vault.create_secret(p_url,'plaid_worker_url'); else perform vault.update_secret(sid,p_url); end if;
  select id into sid from vault.secrets where name='plaid_worker_secret';
  if sid is null then perform vault.create_secret(p_worker_secret,'plaid_worker_secret'); else perform vault.update_secret(sid,p_worker_secret); end if;
  select jobid into job from cron.job where jobname='plaid-sync-worker';
  if job is not null then perform cron.unschedule(job); end if;
  perform cron.schedule('plaid-sync-worker','* * * * *','select app_private.plaid_dispatch();');
end $$;

alter function public.plaid_admin(text,jsonb) rename to plaid_admin_ready;
revoke all on function public.plaid_admin_ready(text,jsonb) from public,anon,authenticated,service_role;
create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
declare result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  result:=public.plaid_admin_ready(p_action,p_payload);
  if p_action='await_data' then update plaid_connections set claimed_at=null where id=(p_payload->>'id')::uuid; end if;
  return result;
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;
