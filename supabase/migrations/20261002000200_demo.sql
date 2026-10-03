create function public.app_demo(p_month text) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := app_private.require_user(); m date := app_private.month_date(p_month);
  bid uuid; sid uuid; cid uuid; tid uuid; item jsonb; income_id uuid;
begin
  if exists(select 1 from import_batches where owner_id=uid and fingerprint='demo-v1:'||p_month) then
    raise exception 'Demo data has already been loaded for this month';
  end if;
  bid := app_private.ensure_month(uid,m);
  if exists(select 1 from monthly_budget_categories where budget_id=bid) or
     exists(select 1 from transactions where owner_id=uid and effective_date>=m and effective_date<m+interval '1 month') then
    raise exception 'Load demo data into an empty month only';
  end if;
  insert into import_batches(owner_id,fingerprint) values(uid,'demo-v1:'||p_month);
  select id into income_id from budget_sections where owner_id=uid and kind='income';
  for item in select value from jsonb_array_elements('[
    {"section":"Income","category":"Salary","planned":420000,"actual":420000,"description":"Demo: October payroll","merchant":"Demo employer"},
    {"section":"Essentials","category":"Housing","planned":150000,"actual":-150000,"description":"Demo: Rent","merchant":"Demo landlord"},
    {"section":"Essentials","category":"Groceries","planned":45000,"actual":-8234,"description":"Demo: Weekly groceries","merchant":"Demo market"},
    {"section":"Lifestyle","category":"Dining","planned":20000,"actual":-4850,"description":"Demo: Dinner with friends","merchant":"Demo cafe"},
    {"section":"Lifestyle","category":"Entertainment","planned":10000,"actual":-1599,"description":"Demo: Movie night","merchant":"Demo cinema"}
  ]'::jsonb) loop
    if item->>'section'='Income' then sid := income_id;
    else
      select id into sid from budget_sections where owner_id=uid and name=item->>'section' and not archived limit 1;
      if sid is null then
        insert into budget_sections(owner_id,name,kind,position) values(uid,item->>'section','spending',1+(select count(*) from budget_sections where owner_id=uid)) returning id into sid;
      end if;
      insert into monthly_budget_sections(owner_id,budget_id,section_id,name,position)
        select uid,bid,id,name,position from budget_sections where id=sid on conflict do nothing;
    end if;
    select id into cid from categories where owner_id=uid and section_id=sid and name=item->>'category' and not archived limit 1;
    if cid is null then insert into categories(owner_id,section_id,name) values(uid,sid,item->>'category') returning id into cid; end if;
    insert into monthly_budget_categories(owner_id,budget_id,category_id,section_id,name,planned_cents)
      values(uid,bid,cid,sid,item->>'category',(item->>'planned')::bigint);
    tid := app_private.put_transaction(uid,jsonb_build_object('original_date',m,'description',item->>'description','merchant',item->>'merchant','amount_cents',item->'actual'),'demo',p_month||':'||cid::text);
    update transaction_allocations set category_id=cid where transaction_id=tid;
  end loop;
  tid := app_private.put_transaction(uid,jsonb_build_object('original_date',m+1,'description','Demo: More groceries','merchant','Demo market','amount_cents',-6575),'demo',p_month||':uncategorized');
  tid := app_private.put_transaction(uid,jsonb_build_object('original_date',m+2,'description','Demo: Refund','merchant','Demo market','amount_cents',1250),'demo',p_month||':refund');
  update transaction_allocations set category_id=(select c.id from categories c join budget_sections s on s.id=c.section_id where c.owner_id=uid and s.name='Essentials' and c.name='Groceries' and not c.archived limit 1) where transaction_id=tid;
end $$;
revoke all on function public.app_demo(text) from public, anon;
grant execute on function public.app_demo(text) to authenticated;
