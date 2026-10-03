begin;
create extension if not exists pgtap with schema extensions;
select plan(6);
insert into auth.users(id,email) values ('00000000-0000-0000-0000-000000000001','sql-test@example.test');
insert into public.budget_sections(id,owner_id,name,kind) values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Income','income');
select throws_ok(
  $$delete from public.budget_sections where id='10000000-0000-0000-0000-000000000001'$$,
  'P0001', 'The Income section is permanent', 'Income cannot be deleted'
);
select throws_ok(
  $$update public.budget_sections set kind='spending' where id='10000000-0000-0000-0000-000000000001'$$,
  'P0001', 'Section classification and ownership are immutable', 'Income classification is fixed'
);
insert into public.transactions(id,owner_id,description,amount_cents,original_date,source)
  values('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','SQL purchase',-10000,'2026-10-31','manual');
insert into public.transaction_allocations(owner_id,transaction_id,amount_cents) values
  ('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',-12000),
  ('00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',2000);
select lives_ok('set constraints all immediate', 'Mixed-sign exact allocations balance');
set constraints all deferred;
update public.transaction_allocations set amount_cents=1999 where amount_cents=2000;
select throws_ok('set constraints all immediate','P0001','Allocation amounts must sum exactly to the parent transaction','Direct SQL cannot bypass exact totals');
update public.transaction_allocations set amount_cents=2000 where amount_cents=1999;
select lives_ok('set constraints all immediate','Repaired total passes');
select is((select effective_date::text from public.transactions where id='20000000-0000-0000-0000-000000000001'),'2026-10-31','Calendar dates retain original month');
select * from finish();
rollback;
