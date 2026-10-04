create table app_private.plaid_record_accounts(
  connection_id uuid not null references app_private.plaid_connections on delete cascade,
  source_id text not null,
  account_id text not null,
  primary key(connection_id,source_id)
);
revoke all on app_private.plaid_record_accounts from public,anon,authenticated;

alter function public.plaid_admin(text,jsonb) rename to plaid_admin_scoped;
revoke all on function public.plaid_admin_scoped(text,jsonb) from public,anon,authenticated,service_role;
create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb language plpgsql security definer
set search_path=public,app_private,pg_temp as $$
declare c plaid_connections; x jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_action='stage' then
    select * into c from plaid_connections where id=(p_payload->>'id')::uuid;
    perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text,0));
    select * into c from plaid_connections where id=(p_payload->>'id')::uuid for update;
    if c.lease is distinct from (p_payload->>'lease')::uuid or c.lease_until<now() or c.status<>'syncing' then raise exception 'Stale sync lease'; end if;
    for x in select value from jsonb_array_elements(p_payload->'changes') where value->>'account_id' is not null loop
      insert into plaid_record_accounts(connection_id,source_id,account_id)
        values(c.id,x->>'source_id',x->>'account_id') on conflict(connection_id,source_id) do update set account_id=excluded.account_id;
    end loop;
  end if;
  return public.plaid_admin_scoped(p_action,p_payload);
end $$;
revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;

create function app_private.plaid_review_visible(r app_private.plaid_records) returns boolean language sql stable
set search_path=app_private,pg_temp as $$
  select r.state='review' and (r.reason<>'invalid' or
    not exists(select 1 from plaid_record_accounts m where m.connection_id=r.connection_id and m.source_id=r.source_id) or
    exists(select 1 from plaid_record_accounts m join plaid_accounts a on a.connection_id=m.connection_id and a.account_id=m.account_id
      where m.connection_id=r.connection_id and m.source_id=r.source_id and a.selected));
$$;
revoke all on function app_private.plaid_review_visible(app_private.plaid_records) from public,anon,authenticated;

create or replace function public.app_banking_internal(p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare uid uuid:=auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if p_offset<0 then raise exception 'Invalid review offset'; end if;
  return jsonb_build_object(
    'connections',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'institution_name',c.institution_name,'environment',c.environment,'status',c.status,
      'import_start',c.import_start,'connected_at',c.connected_at,'last_synced_at',c.last_synced_at,'error_code',c.error_code,
      'accounts',coalesce((select jsonb_agg(jsonb_build_object('account_id',a.account_id,'name',a.name,'mask',a.mask,
        'type',a.type,'subtype',a.subtype,'selected',a.selected) order by a.name) from plaid_accounts a where a.connection_id=c.id),'[]'::jsonb))
      order by c.connected_at desc) from plaid_connections c where c.owner_id=uid),'[]'::jsonb),
    'reviews',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'connection_id',r.connection_id,'version',r.version,
      'reason',r.reason,'record',r.value,'error',r.error,'transaction_id',r.transaction_id,
      'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'description',t.description,'original_date',t.original_date,
        'amount_cents',t.amount_cents,'excluded',t.excluded,'date_override',t.date_override,
        'allocations',coalesce((select jsonb_agg(jsonb_build_object('category_id',a.category_id,'amount_cents',a.amount_cents))
        from transaction_allocations a where a.transaction_id=t.id),'[]'::jsonb)))
        from public.transactions t where t.owner_id=uid and t.id=any(r.candidates)),'[]'::jsonb)))
      from (select * from plaid_records x where owner_id=uid and app_private.plaid_review_visible(x) order by id limit 30 offset p_offset) r),'[]'::jsonb),
    'pending',coalesce((select jsonb_agg(r.value || jsonb_build_object('connection_id',r.connection_id)) from
      (select r.* from plaid_records r join plaid_accounts a on a.connection_id=r.connection_id and a.account_id=r.value->>'account_id'
       where r.owner_id=uid and r.state='pending' and not r.removed and a.selected order by r.id limit 30 offset p_offset) r),'[]'::jsonb),
    'review_total',(select count(*) from plaid_records r where owner_id=uid and app_private.plaid_review_visible(r)),
    'pending_total',(select count(*) from plaid_records r join plaid_accounts a on a.connection_id=r.connection_id and a.account_id=r.value->>'account_id'
      where r.owner_id=uid and r.state='pending' and not r.removed and a.selected));
end $$;
