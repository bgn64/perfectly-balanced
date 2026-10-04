alter table app_private.plaid_records drop constraint plaid_records_owner_id_transaction_id_fkey;
alter table app_private.plaid_records add foreign key(owner_id,transaction_id)
  references public.transactions(owner_id,id) deferrable initially deferred;
alter table app_private.plaid_intents drop constraint plaid_intents_connection_id_fkey;
alter table app_private.plaid_intents add foreign key(connection_id)
  references app_private.plaid_connections(id) deferrable initially deferred;

create function app_private.plaid_delete_secret() returns trigger language plpgsql security definer
set search_path=vault,pg_temp as $$
begin delete from vault.secrets where id=old.secret_id; return old; end $$;
revoke all on function app_private.plaid_delete_secret() from public,anon,authenticated;
create trigger plaid_delete_secret before delete on app_private.plaid_connections
for each row execute function app_private.plaid_delete_secret();

alter table public.transactions add column revision bigint not null default 0;
create function app_private.transaction_revision() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin new.revision:=old.revision+1; return new; end $$;
create trigger transaction_revision before update on public.transactions for each row execute function app_private.transaction_revision();
create function app_private.allocation_revision() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='DELETE' then update public.transactions set revision=revision where id=old.transaction_id; return old; end if;
  update public.transactions set revision=revision where id=new.transaction_id;
  if tg_op='UPDATE' and old.transaction_id<>new.transaction_id then update public.transactions set revision=revision where id=old.transaction_id; end if;
  return new;
end $$;
revoke all on function app_private.transaction_revision(),app_private.allocation_revision() from public,anon,authenticated;
create trigger allocation_revision after insert or update or delete on public.transaction_allocations for each row execute function app_private.allocation_revision();

alter function public.app_banking(integer) rename to app_banking_internal;
revoke all on function public.app_banking_internal(integer) from public,anon,authenticated,service_role;
create function public.app_banking(p_offset integer default 0) returns jsonb language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare result jsonb; reviews jsonb; r jsonb; candidates jsonb; a jsonb; rev bigint;
begin
  result:=public.app_banking_internal(p_offset); reviews:='[]';
  for r in select value from jsonb_array_elements(result->'reviews') loop
    candidates:='[]';
    for a in select value from jsonb_array_elements(r->'candidates') loop
      select revision into rev from public.transactions where owner_id=auth.uid() and id=(a->>'id')::uuid;
      candidates:=candidates || jsonb_build_array(a || jsonb_build_object('revision',rev));
    end loop;
    reviews:=reviews || jsonb_build_array(jsonb_set(r,'{candidates}',candidates));
  end loop;
  return jsonb_set(result,'{reviews}',reviews);
end $$;
revoke all on function public.app_banking(integer) from public,anon;
grant execute on function public.app_banking(integer) to authenticated;

alter function public.app_bank_resolve(uuid,integer,text,uuid,jsonb) rename to app_bank_resolve_internal;
revoke all on function public.app_bank_resolve_internal(uuid,integer,text,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.app_bank_resolve(
  p_id uuid,p_version integer,p_decision text,p_transaction uuid default null,p_allocations jsonb default null,p_revision bigint default null
) returns void language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); r plaid_records; t public.transactions; before_snapshot jsonb;
begin
  select * into r from plaid_records where owner_id=uid and id=p_id for update;
  if not found then raise exception 'Review unavailable'; end if;
  if p_decision not in ('ignore','new') then
    select * into t from public.transactions where owner_id=uid and id=coalesce(r.transaction_id,p_transaction) for update;
    if not found or p_revision is distinct from t.revision then raise exception 'Accepted transaction changed; refresh before resolving'; end if;
    before_snapshot:=app_private.transaction_json(t);
  end if;
  perform public.app_bank_resolve_internal(p_id,p_version,p_decision,p_transaction,p_allocations);
  update plaid_audit set before_value=before_snapshot,
    after_value=case when t.id is null then after_value else (select app_private.transaction_json(x) from public.transactions x where x.id=t.id) end
    where record_id=p_id and created_at=now() and decision=p_decision;
end $$;
revoke all on function public.app_bank_resolve(uuid,integer,text,uuid,jsonb,bigint) from public,anon;
grant execute on function public.app_bank_resolve(uuid,integer,text,uuid,jsonb,bigint) to authenticated;

create table app_private.plaid_requests(owner_id uuid not null references auth.users on delete cascade,created_at timestamptz not null default now());
create index plaid_request_rate on app_private.plaid_requests(owner_id,created_at);
create function public.plaid_rate(p_owner uuid) returns void language plpgsql security definer set search_path=app_private,pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
  delete from plaid_requests where created_at<now()-interval '1 hour';
  if (select count(*) from plaid_requests where owner_id=p_owner and created_at>now()-interval '1 minute')>=15 then
    raise exception 'Too many bank operations';
  end if;
  insert into plaid_requests(owner_id) values(p_owner);
end $$;
revoke all on function public.plaid_rate(uuid) from public,anon,authenticated;
grant execute on function public.plaid_rate(uuid) to service_role;
