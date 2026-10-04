create extension if not exists supabase_vault with schema vault;

alter table public.transactions add column provider_removed boolean not null default false;

create table app_private.plaid_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  item_id text not null unique,
  secret_id uuid not null,
  environment text not null check (environment in ('sandbox','production')),
  institution_name text not null,
  import_start date not null,
  status text not null default 'select_accounts' check (status in ('select_accounts','syncing','active','needs_reconnect','error','disconnecting','disconnected')),
  cursor text,
  page_cursor text,
  lease uuid,
  lease_until timestamptz,
  requested_at timestamptz,
  claimed_at timestamptz,
  due_at timestamptz,
  attempts integer not null default 0,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  error_code text,
  unique(owner_id,id)
);
create table app_private.plaid_accounts (
  connection_id uuid not null references app_private.plaid_connections on delete cascade,
  account_id text not null,
  name text not null,
  mask text,
  type text not null,
  subtype text,
  selected boolean not null default false,
  primary key(connection_id,account_id)
);
create table app_private.plaid_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  connection_id uuid not null,
  source_id text not null,
  value jsonb,
  error text,
  removed boolean not null default false,
  transaction_id uuid,
  state text not null default 'new' check(state in ('new','pending','accepted','ignored','before_start','review')),
  version integer not null default 1,
  reason text check(reason in ('overlap','amount','removed','invalid')),
  candidates uuid[] not null default '{}',
  foreign key(owner_id,connection_id) references app_private.plaid_connections(owner_id,id) on delete cascade,
  foreign key(owner_id,transaction_id) references public.transactions(owner_id,id),
  unique(connection_id,source_id)
);
create table app_private.plaid_staging (
  connection_id uuid not null references app_private.plaid_connections on delete cascade,
  source_id text not null,
  value jsonb,
  error text,
  removed boolean not null,
  primary key(connection_id,source_id)
);
create table app_private.plaid_intents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  import_start date not null,
  created_at timestamptz not null default now(),
  connection_id uuid references app_private.plaid_connections,
  exchanging boolean not null default false
);
create table app_private.plaid_deliveries (
  signature_hash text primary key,
  received_at timestamptz not null default now()
);
create table app_private.plaid_audit (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users on delete cascade,
  record_id uuid,
  decision text not null,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default now()
);
revoke all on all tables in schema app_private from public, anon, authenticated;

create function app_private.plaid_reconcile(p_id uuid) returns void
language plpgsql set search_path=public,app_private,pg_temp as $$
declare r plaid_records; c plaid_connections; t public.transactions; matches uuid[]; pending_tid uuid;
begin
  select * into r from plaid_records where id=p_id for update;
  select * into c from plaid_connections where id=r.connection_id;
  if r.state='ignored' then return; end if;
  if r.error is not null then
    update plaid_records set state='review',reason='invalid' where id=r.id; return;
  end if;
  if r.removed then
    if r.transaction_id is null then
      update plaid_records set state='ignored',reason=null where id=r.id;
    elsif not exists(select 1 from plaid_records where id<>r.id and transaction_id=r.transaction_id and not removed and state='accepted') then
      select * into t from public.transactions where id=r.transaction_id;
      if not t.provider_removed then update plaid_records set state='review',reason='removed',candidates=array[r.transaction_id] where id=r.id; end if;
    end if;
    return;
  end if;
  if r.value is null then raise exception 'Missing normalized provider record'; end if;
  if not exists(select 1 from plaid_accounts where connection_id=c.id and account_id=r.value->>'account_id' and selected) then return; end if;
  if (r.value->>'pending')::boolean then
    update plaid_records set state='pending',reason=null where id=r.id; return;
  end if;
  if r.transaction_id is null then
    select id into pending_tid from public.transactions where owner_id=r.owner_id and source='plaid' and source_id=r.source_id;
    if pending_tid is null and r.value->>'pending_transaction_id' is not null then
      select transaction_id into pending_tid from plaid_records
        where connection_id=c.id and source_id=r.value->>'pending_transaction_id';
      if pending_tid is null then
        select id into pending_tid from public.transactions where owner_id=r.owner_id and source='plaid' and source_id=r.value->>'pending_transaction_id';
      end if;
    end if;
    if pending_tid is not null then
      update plaid_records set transaction_id=pending_tid where id=r.id;
      r.transaction_id := pending_tid;
    end if;
  end if;
  if r.transaction_id is not null then
    select * into t from public.transactions where owner_id=r.owner_id and id=r.transaction_id for update;
    if t.amount_cents<>(r.value->>'amount_cents')::bigint or t.provider_removed then
      if t.provider_removed or exists(select 1 from transaction_allocations where transaction_id=t.id and category_id is not null)
        or (select count(*) from transaction_allocations where transaction_id=t.id)>1 then
        update plaid_records set state='review',reason='amount',candidates=array[t.id] where id=r.id; return;
      end if;
      update transaction_allocations set amount_cents=(r.value->>'amount_cents')::bigint where transaction_id=t.id;
    end if;
    update public.transactions set description=r.value->>'description',merchant=r.value->>'merchant',
      amount_cents=(r.value->>'amount_cents')::bigint,original_date=(r.value->>'original_date')::date
      where id=t.id;
    update plaid_records set state='accepted',reason=null,candidates='{}' where id=r.id;
    return;
  end if;
  if (r.value->>'original_date')::date<c.import_start then
    update plaid_records set state='before_start',reason=null where id=r.id; return;
  end if;
  select coalesce(array_agg(id),'{}') into matches from public.transactions
    where owner_id=r.owner_id and not provider_removed
      and amount_cents=(r.value->>'amount_cents')::bigint
      and abs(original_date-(r.value->>'original_date')::date)<=3
      and trim(regexp_replace(lower(coalesce(nullif(merchant,''),description)),'[^a-z0-9]+',' ','g'))=
        trim(regexp_replace(lower(coalesce(nullif(r.value->>'merchant',''),r.value->>'description')),'[^a-z0-9]+',' ','g'));
  if cardinality(matches)>0 then
    update plaid_records set state='review',reason='overlap',candidates=matches where id=r.id; return;
  end if;
  pending_tid := app_private.put_transaction(r.owner_id,r.value,'plaid',r.source_id);
  update plaid_records set transaction_id=pending_tid,state='accepted',reason=null where id=r.id;
end $$;

create function public.app_banking(p_offset integer default 0) returns jsonb
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
      from (select * from plaid_records where owner_id=uid and state='review' order by id limit 30 offset p_offset) r),'[]'::jsonb),
    'pending',coalesce((select jsonb_agg(r.value || jsonb_build_object('connection_id',r.connection_id)) from
      (select r.* from plaid_records r join plaid_accounts a on a.connection_id=r.connection_id and a.account_id=r.value->>'account_id'
       where r.owner_id=uid and r.state='pending' and not r.removed and a.selected order by r.id limit 30 offset p_offset) r),'[]'::jsonb),
    'review_total',(select count(*) from plaid_records where owner_id=uid and state='review'),
    'pending_total',(select count(*) from plaid_records r join plaid_accounts a on a.connection_id=r.connection_id and a.account_id=r.value->>'account_id'
      where r.owner_id=uid and r.state='pending' and not r.removed and a.selected));
end $$;

create function public.app_bank_resolve(p_id uuid,p_version integer,p_decision text,p_transaction uuid default null,p_allocations jsonb default null) returns void
language plpgsql security definer set search_path=public,app_private,pg_temp as $$
declare uid uuid:=app_private.require_user(); r plaid_records; tid uuid; t public.transactions; a jsonb;
begin
  select * into r from plaid_records where id=p_id and owner_id=uid and state='review' and version=p_version for update;
  if not found then raise exception 'Review changed or is unavailable; refresh before resolving'; end if;
  if p_decision not in ('ignore','new','match','accept') then raise exception 'Invalid review decision'; end if;
  if p_decision='ignore' then
    update plaid_records set state='ignored',reason=null where id=r.id;
  elsif r.reason='invalid' then raise exception 'Invalid provider data cannot be imported';
  elsif r.reason='removed' then
    if p_decision<>'accept' then raise exception 'Accept removal or keep the existing transaction'; end if;
    update public.transactions set provider_removed=true where owner_id=uid and id=r.transaction_id;
    update plaid_records set state='accepted',reason=null where id=r.id;
  else
    if p_decision='new' and r.reason='overlap' then
      tid:=app_private.put_transaction(uid,r.value,'plaid',r.source_id);
    else
      tid:=case when r.reason='amount' then r.transaction_id else p_transaction end;
      if tid is null or not tid=any(r.candidates) then raise exception 'Choose an existing candidate'; end if;
      select * into t from public.transactions where owner_id=uid and id=tid for update;
      if not found then raise exception 'Transaction unavailable'; end if;
      if t.amount_cents<>(r.value->>'amount_cents')::bigint then
        if p_allocations is null or jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0
          then raise exception 'Provide balanced allocations to accept the changed amount'; end if;
        if (select sum((value->>'amount_cents')::bigint) from jsonb_array_elements(p_allocations))<>(r.value->>'amount_cents')::bigint
          then raise exception 'Allocations must sum exactly to the new amount'; end if;
        delete from transaction_allocations where transaction_id=tid;
        for a in select value from jsonb_array_elements(p_allocations) loop
          insert into transaction_allocations(owner_id,transaction_id,category_id,amount_cents)
          values(uid,tid,(a->>'category_id')::uuid,(a->>'amount_cents')::bigint);
        end loop;
      end if;
      update public.transactions set description=r.value->>'description',merchant=r.value->>'merchant',
        original_date=(r.value->>'original_date')::date,amount_cents=(r.value->>'amount_cents')::bigint,provider_removed=false where id=tid;
    end if;
    update plaid_records set transaction_id=tid,state='accepted',reason=null,candidates='{}' where id=r.id;
  end if;
  insert into plaid_audit(owner_id,record_id,decision,before_value,after_value)
    values(uid,r.id,p_decision,to_jsonb(t),jsonb_build_object('record',r.value,'transaction_id',tid,'allocations',p_allocations));
end $$;

create function public.plaid_admin(p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public,app_private,vault,pg_temp as $$
declare uid uuid; cid uuid; c plaid_connections; r jsonb; a jsonb; iid uuid; sid uuid; lease_id uuid; rec plaid_records; out_value jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  uid:=(p_payload->>'owner_id')::uuid; cid:=(p_payload->>'id')::uuid;
  if uid is not null then perform pg_advisory_xact_lock(hashtextextended(uid::text,0)); end if;
  if cid is not null then
    select * into c from plaid_connections where id=cid and (uid is null or owner_id=uid) for update;
    if not found then raise exception 'Connection not found'; end if;
  end if;
  case p_action
  when 'intent' then
    if uid is null then raise exception 'Owner required'; end if;
    if (select count(*) from plaid_intents where owner_id=uid and created_at>now()-interval '1 hour')>=10 then raise exception 'Too many connection attempts; try later'; end if;
    if (p_payload->>'import_start')::date>current_date+1 then raise exception 'Import start must not be later than tomorrow'; end if;
    delete from plaid_intents where owner_id=uid and created_at<now()-interval '1 day' and not exchanging;
    insert into plaid_intents(owner_id,import_start) values(uid,(p_payload->>'import_start')::date) returning id into iid;
    return to_jsonb(iid);
  when 'exchange_claim' then
    select connection_id into cid from plaid_intents where id=(p_payload->>'intent_id')::uuid and owner_id=uid;
    if cid is not null then return jsonb_build_object('id',cid,'complete',true); end if;
    update plaid_intents set exchanging=true where id=(p_payload->>'intent_id')::uuid and owner_id=uid
      and not exchanging and created_at>now()-interval '30 minutes' returning id into iid;
    if iid is null then raise exception 'Connection attempt expired or is already in progress'; end if;
    return jsonb_build_object('complete',false);
  when 'exchange_failed' then
    update plaid_intents set exchanging=false where id=(p_payload->>'intent_id')::uuid and owner_id=uid and connection_id is null;
  when 'create' then
    select id into iid from plaid_intents where id=(p_payload->>'intent_id')::uuid and owner_id=uid and exchanging for update;
    if iid is null then raise exception 'Connection intent unavailable'; end if;
    select id into cid from plaid_connections where item_id=p_payload->>'item_id';
    if cid is not null then raise exception 'Item already stored'; end if;
    select vault.create_secret(p_payload->>'access_token') into sid;
    insert into plaid_connections(owner_id,item_id,secret_id,environment,institution_name,import_start)
      select uid,p_payload->>'item_id',sid,p_payload->>'environment',p_payload->>'institution_name',import_start
      from plaid_intents where id=iid returning id into cid;
    for a in select value from jsonb_array_elements(p_payload->'accounts') loop
      insert into plaid_accounts(connection_id,account_id,name,mask,type,subtype)
        values(cid,a->>'account_id',a->>'name',a->>'mask',a->>'type',a->>'subtype');
    end loop;
    update plaid_intents set connection_id=cid,exchanging=false where id=iid;
    return to_jsonb(cid);
  when 'token' then
    if c.status in ('disconnected','disconnecting') then raise exception 'Connection is disconnected'; end if;
    return jsonb_build_object('access_token',(select decrypted_secret from vault.decrypted_secrets where id=c.secret_id),'environment',c.environment);
  when 'accounts' then
    if c.status in ('disconnected','disconnecting') then raise exception 'Connection is disconnected'; end if;
    if jsonb_array_length(p_payload->'accounts')=0 or exists(
      select 1 from jsonb_array_elements_text(p_payload->'accounts') x where not exists(
        select 1 from plaid_accounts where connection_id=cid and account_id=x and type in ('depository','credit'))) then
      raise exception 'Select eligible accounts belonging to this connection';
    end if;
    update plaid_accounts set selected=account_id in (select jsonb_array_elements_text(p_payload->'accounts')) where connection_id=cid;
    update plaid_connections set status='syncing',requested_at=now(),due_at=now(),error_code=null where id=cid;
    for rec in select * from plaid_records where connection_id=cid and state in ('new','before_start','pending') loop
      perform app_private.plaid_reconcile(rec.id);
    end loop;
  when 'request' then
    if c.status in ('disconnected','disconnecting','select_accounts','needs_reconnect') then raise exception 'Select accounts or repair this connection first'; end if;
    if c.requested_at>now()-interval '30 seconds' then raise exception 'Sync already requested; wait before retrying'; end if;
    update plaid_connections set requested_at=now(),due_at=now(),status='syncing',attempts=0,error_code=null where id=cid;
  when 'repaired' then
    if c.status in ('disconnected','disconnecting') then raise exception 'Connection is disconnected'; end if;
    update plaid_connections set status='syncing',due_at=now(),requested_at=now(),attempts=0,error_code=null where id=cid;
  when 'disconnect_start' then
    if c.status='disconnected' then return jsonb_build_object('complete',true); end if;
    update plaid_connections set status='disconnecting',lease=null,lease_until=null,due_at=null where id=cid;
    return jsonb_build_object('complete',false,'access_token',(select decrypted_secret from vault.decrypted_secrets where id=c.secret_id),'environment',c.environment);
  when 'disconnect_finish' then
    if c.status<>'disconnecting' then raise exception 'Disconnection is not in progress'; end if;
    delete from vault.secrets where id=c.secret_id;
    update plaid_connections set status='disconnected',error_code=null where id=cid;
    delete from plaid_staging where connection_id=cid;
    update plaid_records set state='ignored',reason=null where connection_id=cid and state in ('new','pending','review','before_start');
  when 'disconnect_failed' then
    update plaid_connections set error_code='DISCONNECT_FAILED' where id=cid and status='disconnecting';
  when 'webhook' then
    insert into plaid_deliveries(signature_hash) values(p_payload->>'signature_hash') on conflict do nothing;
    if not found then return null; end if;
    delete from plaid_deliveries where received_at<now()-interval '1 day';
    select * into c from plaid_connections where item_id=p_payload->>'item_id' for update;
    if not found or c.status in ('disconnected','disconnecting') then return null; end if;
    if p_payload->>'code'='USER_PERMISSION_REVOKED' then
      update plaid_connections set status='disconnecting',lease=null,lease_until=null,due_at=null,error_code='USER_PERMISSION_REVOKED' where id=c.id;
      delete from vault.secrets where id=c.secret_id;
      update plaid_connections set status='disconnected' where id=c.id;
      update plaid_records set state='ignored',reason=null where connection_id=c.id and state in ('pending','review','new','before_start');
    elsif p_payload->>'error_code' in ('ITEM_LOGIN_REQUIRED','PENDING_DISCONNECT','PENDING_EXPIRATION') then
      update plaid_connections set status='needs_reconnect',error_code=p_payload->>'error_code',lease=null,lease_until=null where id=c.id;
    elsif p_payload->>'code'='SYNC_UPDATES_AVAILABLE' or p_payload->>'code'='LOGIN_REPAIRED' then
      update plaid_connections set requested_at=now(),due_at=now(),
        status=case when status='select_accounts' then status else 'syncing' end where id=c.id;
    end if;
  when 'claim' then
    select * into c from plaid_connections where
      environment=p_payload->>'environment' and status in ('active','syncing','error') and attempts<8
      and (lease_until is null or lease_until<now())
      and (due_at<=now() or (last_synced_at<now()-interval '6 hours' and due_at is null))
      order by due_at nulls last limit 1 for update skip locked;
    if not found then return null; end if;
    lease_id:=gen_random_uuid();
    update plaid_connections set lease=lease_id,lease_until=now()+interval '2 minutes',
      claimed_at=coalesce(claimed_at,now()),status='syncing' where id=c.id;
    return jsonb_build_object('id',c.id,'lease',lease_id,'cursor',coalesce(c.page_cursor,c.cursor),
      'access_token',(select decrypted_secret from vault.decrypted_secrets where id=c.secret_id));
  when 'stage' then
    if c.lease is distinct from (p_payload->>'lease')::uuid or c.lease_until<now() or c.status<>'syncing' then raise exception 'Stale sync lease'; end if;
    for r in select value from jsonb_array_elements(p_payload->'changes') loop
      insert into plaid_staging(connection_id,source_id,value,error,removed)
        values(cid,r->>'source_id',nullif(r->'value','null'::jsonb),r->>'error',(r->>'removed')::boolean)
        on conflict(connection_id,source_id) do update set
          value=coalesce(excluded.value,plaid_staging.value),error=excluded.error,removed=excluded.removed;
    end loop;
    update plaid_connections set page_cursor=p_payload->>'next_cursor' where id=cid;
    if (p_payload->>'has_more')::boolean then
      update plaid_connections set lease=null,lease_until=null,due_at=now() where id=cid; return null;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text,0));
    for r in select to_jsonb(s) from plaid_staging s where connection_id=cid order by removed,source_id loop
      insert into plaid_records(owner_id,connection_id,source_id,value,error,removed)
        values(c.owner_id,cid,r->>'source_id',nullif(r->'value','null'::jsonb),r->>'error',(r->>'removed')::boolean)
        on conflict(connection_id,source_id) do update set
          value=coalesce(excluded.value,plaid_records.value),error=excluded.error,removed=excluded.removed,
          version=plaid_records.version+1;
    end loop;
    for rec in select * from plaid_records where connection_id=cid and source_id in
      (select source_id from plaid_staging where connection_id=cid) order by removed,source_id loop
      perform app_private.plaid_reconcile(rec.id);
    end loop;
    delete from plaid_staging where connection_id=cid;
    update plaid_connections set cursor=page_cursor,page_cursor=null,lease=null,lease_until=null,
      due_at=case when requested_at>claimed_at then now() else null end,
      status=case when requested_at>claimed_at then 'syncing' else 'active' end,
      claimed_at=null,last_synced_at=now(),attempts=0,error_code=null where id=cid;
  when 'restart' then
    if c.lease is distinct from (p_payload->>'lease')::uuid then raise exception 'Stale sync lease'; end if;
    delete from plaid_staging where connection_id=cid;
    update plaid_connections set page_cursor=null,lease=null,lease_until=null,due_at=now()+interval '10 seconds',
      attempts=attempts+1,error_code='TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' where id=cid;
  when 'failure' then
    if c.lease is distinct from (p_payload->>'lease')::uuid then raise exception 'Stale sync lease'; end if;
    update plaid_connections set lease=null,lease_until=null,attempts=attempts+1,error_code=p_payload->>'error_code',
      status=case when p_payload->>'error_code'='ITEM_LOGIN_REQUIRED' then 'needs_reconnect' else 'error' end,
      due_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer)) where id=cid;
  else raise exception 'Unknown Plaid operation';
  end case;
  return null;
end $$;

revoke all on function public.plaid_admin(text,jsonb) from public,anon,authenticated;
grant execute on function public.plaid_admin(text,jsonb) to service_role;
revoke all on function public.app_banking(integer),public.app_bank_resolve(uuid,integer,text,uuid,jsonb) from public,anon;
grant execute on function public.app_banking(integer),public.app_bank_resolve(uuid,integer,text,uuid,jsonb) to authenticated;
revoke all on function app_private.plaid_reconcile(uuid) from public,anon,authenticated;

create or replace function public.app_month(p_month text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid:=app_private.require_user(); m date:=app_private.month_date(p_month); bid uuid;
begin
  bid:=app_private.ensure_month(uid,m);
  return jsonb_build_object(
    'sections',coalesce((select jsonb_agg(s order by s.position,s.id) from budget_sections s where owner_id=uid),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(c order by c.name,c.id) from categories c where owner_id=uid),'[]'::jsonb),
    'budget_sections',coalesce((select jsonb_agg(s order by s.position,s.section_id) from monthly_budget_sections s where owner_id=uid and budget_id=bid),'[]'::jsonb),
    'budget_categories',coalesce((select jsonb_agg(c order by c.position,c.category_id) from monthly_budget_categories c where owner_id=uid and budget_id=bid),'[]'::jsonb),
    'transactions',coalesce((select jsonb_agg(app_private.transaction_json(t) order by effective_date desc,id) from transactions t
      where owner_id=uid and not excluded and not provider_removed and effective_date>=m and effective_date<m+interval '1 month'),'[]'::jsonb));
end $$;
create or replace function public.app_history(p_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid:=auth.uid(); target transactions;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select * into target from transactions where owner_id=uid and id=p_id;
  if not found then raise exception 'Transaction not found'; end if;
  return coalesce((select jsonb_agg(app_private.transaction_json(t)) from transactions t where owner_id=uid and id<>p_id and not excluded and not provider_removed
    and ((trim(target.merchant)<>'' and trim(regexp_replace(lower(t.merchant),'[^a-z0-9]+',' ','g'))=trim(regexp_replace(lower(target.merchant),'[^a-z0-9]+',' ','g')))
      or trim(regexp_replace(lower(t.description),'[^a-z0-9]+',' ','g'))=trim(regexp_replace(lower(target.description),'[^a-z0-9]+',' ','g')))),'[]'::jsonb);
end $$;
create or replace function public.app_page(
  p_month text,p_search text default '',p_uncategorized boolean default false,
  p_excluded text default 'hide',p_category uuid default null,p_offset integer default 0,p_sort text default 'date_desc'
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid:=auth.uid(); m date:=app_private.month_date(p_month); result jsonb;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if p_excluded not in ('hide','include','only') or p_sort not in ('date_desc','date_asc','amount_asc','amount_desc') or p_offset<0 then raise exception 'Invalid transaction filter'; end if;
  with matched as (
    select t.* from transactions t where owner_id=uid and effective_date>=m and effective_date<m+interval '1 month'
    and (p_excluded='include' or (p_excluded='hide' and not excluded and not provider_removed) or (p_excluded='only' and (excluded or provider_removed)))
    and (p_search='' or lower(description || ' ' || merchant) like '%' || replace(replace(replace(lower(p_search),'\','\\'),'%','\%'),'_','\_') || '%')
    and (not p_uncategorized or exists(select 1 from transaction_allocations a where a.transaction_id=t.id and a.category_id is null))
    and (p_category is null or exists(select 1 from transaction_allocations a where a.transaction_id=t.id and a.category_id=p_category))
  ), page as (
    select * from matched order by
      case when p_sort='date_desc' then effective_date end desc,
      case when p_sort='date_asc' then effective_date end asc,
      case when p_sort='amount_asc' then amount_cents end asc,
      case when p_sort='amount_desc' then amount_cents end desc,id limit 30 offset p_offset
  )
  select jsonb_build_object('total',(select count(*) from matched),'items',coalesce((select jsonb_agg(app_private.transaction_json(p)) from page p),'[]'::jsonb)) into result;
  return result;
end $$;
