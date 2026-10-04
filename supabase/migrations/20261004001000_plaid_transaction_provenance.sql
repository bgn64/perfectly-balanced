create or replace function app_private.transaction_json(t public.transactions) returns jsonb language sql stable
set search_path=public,app_private,pg_temp as $$
  select to_jsonb(t) || jsonb_build_object(
    'allocations',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from transaction_allocations a where a.transaction_id=t.id),'[]'::jsonb),
    'bank_accounts',coalesce((select jsonb_agg(x.account order by x.account->>'institution',x.account->>'name') from (
      select distinct jsonb_build_object('institution',c.institution_name,'name',a.name,'mask',a.mask) as account
      from plaid_records r join plaid_connections c on c.owner_id=r.owner_id and c.id=r.connection_id
      join plaid_accounts a on a.connection_id=r.connection_id and a.account_id=r.value->>'account_id'
      where r.owner_id=t.owner_id and r.transaction_id=t.id
    ) x),'[]'::jsonb));
$$;
