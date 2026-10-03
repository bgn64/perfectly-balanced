create schema app_private;
revoke all on schema app_private from public;

create table public.budget_sections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  kind text not null check (kind in ('income', 'spending')),
  archived boolean not null default false,
  position integer not null default 0,
  unique (owner_id, id),
  check (kind <> 'income' or (name = 'Income' and not archived))
);
create unique index one_income on public.budget_sections(owner_id) where kind = 'income';
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  section_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 100),
  archived boolean not null default false,
  foreign key (owner_id, section_id) references public.budget_sections(owner_id, id) deferrable initially deferred,
  unique (owner_id, id),
  unique (owner_id, id, section_id)
);
create table public.monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  unique (owner_id, month),
  unique (owner_id, id)
);
create table public.monthly_budget_sections (
  owner_id uuid not null,
  budget_id uuid not null,
  section_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 100),
  position integer not null default 0,
  primary key (budget_id, section_id),
  unique (owner_id, budget_id, section_id),
  foreign key (owner_id, budget_id) references public.monthly_budgets(owner_id, id) on delete cascade,
  foreign key (owner_id, section_id) references public.budget_sections(owner_id, id) deferrable initially deferred
);
create table public.monthly_budget_categories (
  owner_id uuid not null,
  budget_id uuid not null,
  category_id uuid not null,
  section_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 100),
  planned_cents bigint not null default 0 check (planned_cents between 0 and 100000000000),
  position integer not null default 0,
  primary key (budget_id, category_id),
  foreign key (owner_id, budget_id, section_id) references public.monthly_budget_sections(owner_id, budget_id, section_id) on delete cascade,
  foreign key (owner_id, category_id, section_id) references public.categories(owner_id, id, section_id) deferrable initially deferred
);
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (owner_id, fingerprint)
);
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  description text not null check (length(trim(description)) between 1 and 500),
  merchant text not null default '' check (length(merchant) <= 200),
  amount_cents bigint not null check (amount_cents <> 0 and amount_cents between -100000000000 and 100000000000),
  currency text not null default 'USD' check (currency = 'USD'),
  original_date date not null,
  date_override date,
  effective_date date generated always as (coalesce(date_override, original_date)) stored,
  excluded boolean not null default false,
  source text not null check (source in ('manual', 'csv', 'demo', 'plaid')),
  source_id text,
  created_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, source, source_id)
);
create index transaction_month on public.transactions(owner_id, effective_date, id);
create index transaction_merchant on public.transactions(owner_id, lower(merchant));
create extension if not exists pg_trgm with schema extensions;
create index transaction_search on public.transactions using gin ((lower(description || ' ' || merchant)) extensions.gin_trgm_ops);
create table public.transaction_allocations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  transaction_id uuid not null,
  category_id uuid,
  amount_cents bigint not null check (amount_cents <> 0 and amount_cents between -100000000000 and 100000000000),
  foreign key (owner_id, transaction_id) references public.transactions(owner_id, id) on delete cascade,
  foreign key (owner_id, category_id) references public.categories(owner_id, id) deferrable initially deferred
);
create index allocation_parent on public.transaction_allocations(transaction_id);
create index allocation_category on public.transaction_allocations(owner_id, category_id);

create function app_private.guard_catalog() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'budget_sections' then
    if tg_op = 'DELETE' and old.kind = 'income' and exists(select 1 from auth.users where id=old.owner_id) then raise exception 'The Income section is permanent'; end if;
    if tg_op = 'UPDATE' and (new.kind <> old.kind or new.owner_id <> old.owner_id) then
      raise exception 'Section classification and ownership are immutable';
    end if;
  elsif tg_op = 'UPDATE' and (new.section_id <> old.section_id or new.owner_id <> old.owner_id) then
    raise exception 'Category section and ownership are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_sections before update or delete on public.budget_sections for each row execute function app_private.guard_catalog();
create trigger guard_categories before update on public.categories for each row execute function app_private.guard_catalog();

create function app_private.check_allocations() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare tid uuid; expected bigint; actual numeric;
begin
  if tg_table_name = 'transactions' then tid := new.id;
  elsif tg_op = 'DELETE' then tid := old.transaction_id;
  else tid := new.transaction_id; end if;
  select amount_cents into expected from transactions where id = tid;
  if expected is null then return null; end if;
  select coalesce(sum(amount_cents), 0) into actual from transaction_allocations where transaction_id = tid;
  if actual <> expected then raise exception 'Allocation amounts must sum exactly to the parent transaction'; end if;
  if tg_table_name = 'transaction_allocations' and tg_op = 'UPDATE' then
    if old.transaction_id <> new.transaction_id then
      select amount_cents into expected from transactions where id = old.transaction_id;
      select coalesce(sum(amount_cents), 0) into actual from transaction_allocations where transaction_id = old.transaction_id;
      if expected is not null and actual <> expected then raise exception 'Original transaction allocations no longer balance'; end if;
    end if;
  end if;
  return null;
end $$;
create constraint trigger allocations_balance after insert or update or delete on public.transaction_allocations
  deferrable initially deferred for each row execute function app_private.check_allocations();
create constraint trigger parent_balance after insert or update on public.transactions
  deferrable initially deferred for each row execute function app_private.check_allocations();

do $$ declare t text;
begin
  foreach t in array array['budget_sections','categories','monthly_budgets','monthly_budget_sections','monthly_budget_categories','transactions','transaction_allocations','import_batches'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owned_read on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create function app_private.require_user() returns uuid language plpgsql set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  return uid;
end $$;
create function app_private.month_date(value text) returns date language plpgsql immutable as $$
begin
  if value !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Use a month in YYYY-MM format'; end if;
  return (value || '-01')::date;
end $$;
create function app_private.ensure_month(uid uuid, m date) returns uuid language plpgsql set search_path = public, pg_temp as $$
declare bid uuid; sid uuid;
begin
  insert into budget_sections(owner_id, name, kind) values(uid, 'Income', 'income') on conflict do nothing;
  select id into sid from budget_sections where owner_id = uid and kind = 'income';
  insert into monthly_budgets(owner_id, month) values(uid, m) on conflict do nothing;
  select id into bid from monthly_budgets where owner_id = uid and month = m;
  insert into monthly_budget_sections(owner_id,budget_id,section_id,name) values(uid,bid,sid,'Income') on conflict do nothing;
  return bid;
end $$;
create function app_private.transaction_json(t public.transactions) returns jsonb language sql stable set search_path = public, pg_temp as $$
  select to_jsonb(t) || jsonb_build_object('allocations', coalesce((
    select jsonb_agg(to_jsonb(a) order by a.id) from transaction_allocations a where a.transaction_id = t.id
  ), '[]'::jsonb));
$$;

create function public.app_month(p_month text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app_private.require_user(); m date := app_private.month_date(p_month); bid uuid;
begin
  bid := app_private.ensure_month(uid,m);
  return jsonb_build_object(
    'sections', coalesce((select jsonb_agg(s order by s.position,s.id) from budget_sections s where owner_id=uid),'[]'::jsonb),
    'categories', coalesce((select jsonb_agg(c order by c.name,c.id) from categories c where owner_id=uid),'[]'::jsonb),
    'budget_sections', coalesce((select jsonb_agg(s order by s.position,s.section_id) from monthly_budget_sections s where owner_id=uid and budget_id=bid),'[]'::jsonb),
    'budget_categories', coalesce((select jsonb_agg(c order by c.position,c.category_id) from monthly_budget_categories c where owner_id=uid and budget_id=bid),'[]'::jsonb),
    'transactions', coalesce((select jsonb_agg(app_private.transaction_json(t) order by effective_date desc,id) from transactions t
      where owner_id=uid and not excluded and effective_date>=m and effective_date<(m+interval '1 month')),'[]'::jsonb));
end $$;

create function public.app_page(
  p_month text, p_search text default '', p_uncategorized boolean default false,
  p_excluded text default 'hide', p_category uuid default null, p_offset integer default 0,
  p_sort text default 'date_desc'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m date := app_private.month_date(p_month); result jsonb;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if p_excluded not in ('hide','include','only') or p_sort not in ('date_desc','date_asc','amount_asc','amount_desc') or p_offset < 0 then raise exception 'Invalid transaction filter'; end if;
  with matched as (
    select t.* from transactions t where owner_id=uid and effective_date>=m and effective_date<(m+interval '1 month')
    and (p_excluded='include' or (p_excluded='hide' and not excluded) or (p_excluded='only' and excluded))
    and (p_search='' or lower(description || ' ' || merchant) like '%' || replace(replace(replace(lower(p_search),'\','\\'),'%','\%'),'_','\_') || '%')
    and (not p_uncategorized or exists(select 1 from transaction_allocations a where a.transaction_id=t.id and a.category_id is null))
    and (p_category is null or exists(select 1 from transaction_allocations a where a.transaction_id=t.id and a.category_id=p_category))
  ), page as (
    select * from matched order by
      case when p_sort='date_desc' then effective_date end desc,
      case when p_sort='date_asc' then effective_date end asc,
      case when p_sort='amount_asc' then amount_cents end asc,
      case when p_sort='amount_desc' then amount_cents end desc, id
    limit 30 offset p_offset
  )
  select jsonb_build_object('total',(select count(*) from matched),'items',coalesce((select jsonb_agg(app_private.transaction_json(p)) from page p),'[]'::jsonb)) into result;
  return result;
end $$;

create function public.app_history(p_id uuid) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); target transactions;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  select * into target from transactions where owner_id=uid and id=p_id;
  if not found then raise exception 'Transaction not found'; end if;
  return coalesce((select jsonb_agg(app_private.transaction_json(t)) from transactions t where owner_id=uid and id<>p_id and not excluded
    and ((target.merchant<>'' and regexp_replace(lower(t.merchant),'[^a-z0-9]+',' ','g')=regexp_replace(lower(target.merchant),'[^a-z0-9]+',' ','g'))
      or regexp_replace(lower(t.description),'[^a-z0-9]+',' ','g')=regexp_replace(lower(target.description),'[^a-z0-9]+',' ','g'))),'[]'::jsonb);
end $$;

create function app_private.put_transaction(uid uuid, row_data jsonb, src text, src_id text) returns uuid language plpgsql set search_path = public, pg_temp as $$
declare tid uuid;
begin
  insert into transactions(owner_id,description,merchant,amount_cents,original_date,source,source_id)
  values(uid,trim(row_data->>'description'),coalesce(row_data->>'merchant',''),(row_data->>'amount_cents')::bigint,(row_data->>'original_date')::date,src,src_id)
  returning id into tid;
  insert into transaction_allocations(owner_id,transaction_id,amount_cents) values(uid,tid,(row_data->>'amount_cents')::bigint);
  return tid;
end $$;

create function public.app_mutate(p_action text, p_payload jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := app_private.require_user(); bid uuid; sid uuid; cid uuid; tid uuid;
  target transactions; item jsonb; m date; source_bid uuid; total numeric;
begin
  if p_action in ('section_add','section_attach','category_add','category_attach','planned','rename_section','rename_category','remove_category','remove_section','copy','reorder') then
    m := app_private.month_date(p_payload->>'month'); bid := app_private.ensure_month(uid,m);
  end if;
  case p_action
  when 'section_add' then
    insert into budget_sections(owner_id,name,kind,position) values(uid,trim(p_payload->>'name'),'spending',
      (select coalesce(max(position),0)+1 from budget_sections where owner_id=uid)) returning id into sid;
    insert into monthly_budget_sections(owner_id,budget_id,section_id,name,position)
      select uid,bid,id,name,position from budget_sections where id=sid;
  when 'section_attach' then
    sid := (p_payload->>'id')::uuid;
    insert into monthly_budget_sections(owner_id,budget_id,section_id,name,position)
      select uid,bid,id,name,position from budget_sections where owner_id=uid and id=sid and not archived;
    if not found then raise exception 'Active section not found'; end if;
  when 'category_add' then
    sid := (p_payload->>'section_id')::uuid;
    if not exists(select 1 from budget_sections where owner_id=uid and id=sid and not archived) then raise exception 'Active section not found'; end if;
    insert into categories(owner_id,section_id,name) values(uid,sid,trim(p_payload->>'name')) returning id into cid;
    insert into monthly_budget_categories(owner_id,budget_id,category_id,section_id,name,planned_cents,position)
      values(uid,bid,cid,sid,trim(p_payload->>'name'),(p_payload->>'planned_cents')::bigint,
        (select coalesce(max(position),0)+1 from monthly_budget_categories where budget_id=bid and section_id=sid));
  when 'category_attach' then
    cid := (p_payload->>'id')::uuid;
    select section_id into sid from categories where owner_id=uid and id=cid and not archived;
    if not found or not exists(select 1 from budget_sections where id=sid and owner_id=uid and not archived) then raise exception 'Active category not found'; end if;
    insert into monthly_budget_sections(owner_id,budget_id,section_id,name,position)
      select uid,bid,id,name,position from budget_sections where id=sid on conflict do nothing;
    insert into monthly_budget_categories(owner_id,budget_id,category_id,section_id,name,planned_cents,position)
      select uid,bid,id,section_id,name,0,999 from categories where id=cid;
  when 'planned' then
    update monthly_budget_categories set planned_cents=(p_payload->>'planned_cents')::bigint
      where owner_id=uid and budget_id=bid and category_id=(p_payload->>'id')::uuid;
    if not found then raise exception 'Monthly category not found'; end if;
  when 'rename_section' then
    sid := (p_payload->>'id')::uuid;
    update budget_sections set name=trim(p_payload->>'name') where owner_id=uid and id=sid and kind='spending' and not archived;
    if not found then raise exception 'Only active spending sections can be renamed'; end if;
    update monthly_budget_sections set name=trim(p_payload->>'name') where owner_id=uid and budget_id=bid and section_id=sid;
  when 'rename_category' then
    cid := (p_payload->>'id')::uuid;
    update categories set name=trim(p_payload->>'name') where owner_id=uid and id=cid and not archived;
    if not found then raise exception 'Active category not found'; end if;
    update monthly_budget_categories set name=trim(p_payload->>'name') where owner_id=uid and budget_id=bid and category_id=cid;
  when 'remove_category' then
    cid := (p_payload->>'id')::uuid;
    if exists(select 1 from transaction_allocations a join transactions t on t.id=a.transaction_id
      where t.owner_id=uid and a.category_id=cid and t.effective_date>=m and t.effective_date<m+interval '1 month') then
      raise exception 'Reassign this month''s transactions before removing the category (including excluded transactions)';
    end if;
    delete from monthly_budget_categories where owner_id=uid and budget_id=bid and category_id=cid;
    if not found then raise exception 'Monthly category not found'; end if;
  when 'remove_section' then
    sid := (p_payload->>'id')::uuid;
    if not exists(select 1 from budget_sections where owner_id=uid and id=sid and kind='spending') then raise exception 'Income is permanent or section unavailable'; end if;
    if exists(select 1 from monthly_budget_categories where owner_id=uid and budget_id=bid and section_id=sid) then raise exception 'Remove or reassign section categories first'; end if;
    delete from monthly_budget_sections where owner_id=uid and budget_id=bid and section_id=sid;
    if not found then raise exception 'Monthly section not found'; end if;
  when 'archive_category' then
    update categories set archived=true where owner_id=uid and id=(p_payload->>'id')::uuid;
    if not found then raise exception 'Category not found'; end if;
  when 'archive_section' then
    sid := (p_payload->>'id')::uuid;
    update budget_sections set archived=true where owner_id=uid and id=sid and kind='spending';
    if not found then raise exception 'Income is permanent or section unavailable'; end if;
    update categories set archived=true where owner_id=uid and section_id=sid;
  when 'copy' then
    if exists(select 1 from monthly_budget_categories where budget_id=bid) or
      exists(select 1 from monthly_budget_sections s join budget_sections c on c.id=s.section_id where s.budget_id=bid and c.kind='spending') then
      raise exception 'Copy requires an empty destination budget';
    end if;
    select id into source_bid from monthly_budgets where owner_id=uid and month=app_private.month_date(p_payload->>'from_month');
    if not found or source_bid=bid then raise exception 'Choose a different existing source month'; end if;
    insert into monthly_budget_sections(owner_id,budget_id,section_id,name,position)
      select uid,bid,s.section_id,s.name,s.position from monthly_budget_sections s join budget_sections c on c.id=s.section_id
      where s.budget_id=source_bid and not c.archived
      on conflict (budget_id,section_id) do update set name=excluded.name,position=excluded.position;
    insert into monthly_budget_categories(owner_id,budget_id,category_id,section_id,name,planned_cents,position)
      select uid,bid,c.category_id,c.section_id,c.name,c.planned_cents,c.position
      from monthly_budget_categories c join categories cat on cat.id=c.category_id join budget_sections s on s.id=c.section_id
      where c.budget_id=source_bid and not cat.archived and not s.archived;
  when 'reorder' then
    if p_payload->>'type'='section' then
      sid := (p_payload->>'id')::uuid;
      if not exists(select 1 from monthly_budget_sections s join budget_sections c on c.id=s.section_id where s.owner_id=uid and s.budget_id=bid and s.section_id=sid and c.kind='spending') then raise exception 'Only spending sections can be reordered'; end if;
      with ranked as (
        select s.section_id,row_number() over(order by s.position,s.section_id)::integer as n
        from monthly_budget_sections s join budget_sections c on c.id=s.section_id where s.budget_id=bid and c.kind='spending'
      ), current_row as (select n from ranked where section_id=sid), neighbor as (
        select section_id,n from ranked where n=(select n from current_row) +
          case when (p_payload->>'position')::integer < (select position from monthly_budget_sections where budget_id=bid and section_id=sid) then -1 else 1 end
      )
      update monthly_budget_sections s set position=case
        when s.section_id=sid then coalesce((select n from neighbor),(select n from current_row))
        when s.section_id=(select section_id from neighbor) then (select n from current_row)
        else r.n end
      from ranked r where s.budget_id=bid and s.section_id=r.section_id;
    elsif p_payload->>'type'='category' then
      cid := (p_payload->>'id')::uuid;
      select section_id into sid from monthly_budget_categories where owner_id=uid and budget_id=bid and category_id=cid;
      if not found then raise exception 'Monthly category not found'; end if;
      with ranked as (
        select category_id,row_number() over(order by position,category_id)::integer as n
        from monthly_budget_categories where budget_id=bid and section_id=sid
      ), current_row as (select n from ranked where category_id=cid), neighbor as (
        select category_id,n from ranked where n=(select n from current_row) +
          case when (p_payload->>'position')::integer < (select position from monthly_budget_categories where budget_id=bid and category_id=cid) then -1 else 1 end
      )
      update monthly_budget_categories c set position=case
        when c.category_id=cid then coalesce((select n from neighbor),(select n from current_row))
        when c.category_id=(select category_id from neighbor) then (select n from current_row)
        else r.n end
      from ranked r where c.budget_id=bid and c.category_id=r.category_id;
    else raise exception 'Invalid reorder type'; end if;
    if not found then raise exception 'Budget entry not found'; end if;
  when 'manual' then
    tid := app_private.put_transaction(uid,p_payload,'manual',null);
  when 'split' then
    tid := (p_payload->>'id')::uuid;
    select * into target from transactions where owner_id=uid and id=tid for update;
    if not found then raise exception 'Transaction not found'; end if;
    if jsonb_typeof(p_payload->'allocations') <> 'array' or jsonb_array_length(p_payload->'allocations')=0 then raise exception 'Provide allocations'; end if;
    select sum((x->>'amount_cents')::bigint) into total from jsonb_array_elements(p_payload->'allocations') x;
    if total <> target.amount_cents then raise exception 'Split amounts must sum exactly to the original transaction'; end if;
    for item in select value from jsonb_array_elements(p_payload->'allocations') loop
      cid := (item->>'category_id')::uuid;
      if cid is not null and not exists(
        select 1 from categories c join budget_sections s on s.id=c.section_id
        where c.owner_id=uid and c.id=cid and (
          (not c.archived and not s.archived) or exists(select 1 from transaction_allocations a where a.transaction_id=tid and a.category_id=cid)
        )) then raise exception 'Category unavailable'; end if;
    end loop;
    delete from transaction_allocations where transaction_id=tid;
    insert into transaction_allocations(owner_id,transaction_id,category_id,amount_cents)
      select uid,tid,(x->>'category_id')::uuid,(x->>'amount_cents')::bigint from jsonb_array_elements(p_payload->'allocations') x;
  when 'date' then
    update transactions set date_override=(p_payload->>'date')::date where owner_id=uid and id=(p_payload->>'id')::uuid;
    if not found then raise exception 'Transaction not found'; end if;
  when 'exclude' then
    update transactions set excluded=(p_payload->>'excluded')::boolean where owner_id=uid and id=(p_payload->>'id')::uuid;
    if not found then raise exception 'Transaction not found'; end if;
  when 'import' then
    if length(coalesce(p_payload->>'fingerprint',''))<>64 then raise exception 'Invalid import fingerprint'; end if;
    if jsonb_typeof(p_payload->'rows') <> 'array' or jsonb_array_length(p_payload->'rows') not between 1 and 1000 then raise exception 'Import 1 to 1,000 rows'; end if;
    insert into import_batches(owner_id,fingerprint) values(uid,p_payload->>'fingerprint');
    for item in select value from jsonb_array_elements(p_payload->'rows') loop
      tid := app_private.put_transaction(uid,item,'csv',coalesce(nullif(item->>'external_id',''),p_payload->>'fingerprint'||':'||(item->>'row_number')));
    end loop;
  else raise exception 'Unknown action: %',p_action;
  end case;
  return jsonb_build_object('ok',true,'id',tid);
end $$;

create function public.app_import_preview(p_fingerprint text, p_rows jsonb) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'Invalid preview rows'; end if;
  return jsonb_build_object(
    'repeated',exists(select 1 from import_batches where owner_id=uid and fingerprint=p_fingerprint),
    'duplicates',coalesce((select jsonb_agg(jsonb_build_object('row',r.ordinality,'exact',exists(
      select 1 from transactions t where t.owner_id=uid and t.source='csv' and t.source_id=r.value->>'external_id'
    ))) from jsonb_array_elements(p_rows) with ordinality r
    where exists(select 1 from transactions t where t.owner_id=uid and (
      (t.source='csv' and t.source_id=r.value->>'external_id') or
      (t.original_date=(r.value->>'original_date')::date and t.amount_cents=(r.value->>'amount_cents')::bigint and t.description=r.value->>'description')
    ))),'[]'::jsonb));
end $$;

revoke all on all functions in schema app_private from public, anon, authenticated;
revoke all on function public.app_month(text), public.app_page(text,text,boolean,text,uuid,integer,text),
  public.app_history(uuid), public.app_mutate(text,jsonb), public.app_import_preview(text,jsonb) from public, anon;
grant execute on function public.app_month(text), public.app_page(text,text,boolean,text,uuid,integer,text),
  public.app_history(uuid), public.app_mutate(text,jsonb), public.app_import_preview(text,jsonb) to authenticated;
