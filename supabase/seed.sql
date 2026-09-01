insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'dev@example.test',
  crypt('local-dev-password', gen_salt('bf')),
  now(),
  '',
  '',
  '',
  '',
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(),
  now()
)
on conflict (id) do update
set encrypted_password = excluded.encrypted_password,
    email_confirmed_at = excluded.email_confirmed_at,
    confirmation_token = excluded.confirmation_token,
    email_change = excluded.email_change,
    email_change_token_new = excluded.email_change_token_new,
    recovery_token = excluded.recovery_token,
    raw_app_meta_data = excluded.raw_app_meta_data,
    updated_at = now();

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '{"sub":"00000000-0000-0000-0000-000000000001","email":"dev@example.test","email_verified":true,"phone_verified":false}',
  'email',
  now(),
  now()
)
on conflict (id) do update
set identity_data = excluded.identity_data,
    updated_at = now();

insert into public.categories (id, user_id, name)
values
  (
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'Internet'
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Katie Pay'
  ),
  (
    '10000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'Ben Pay'
  ),
  (
    '10000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'Groceries'
  ),
  (
    '10000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000001',
    'Restaurants'
  ),
  (
    '10000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000001',
    'YouTube Premium'
  )
on conflict (id) do update
set name = excluded.name,
    updated_at = now();

insert into public.budgets (id, user_id, month)
values (
  '20000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  date '2026-08-01'
)
on conflict (id) do update
set updated_at = now();

insert into public.budget_subsections (id, user_id, budget_id, name, position)
values
  (
    '30000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Income',
    1
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Food',
    2
  ),
  (
    '30000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Subscriptions',
    3
  )
on conflict (id) do update
set name = excluded.name,
    position = excluded.position,
    updated_at = now();

insert into public.budget_category_allocations (
  id,
  user_id,
  budget_id,
  category_id,
  subsection_id,
  amount,
  direction,
  position
)
values
  (
    '40000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    null,
    -60,
    'spending',
    0
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000001',
    0,
    'income',
    0
  ),
  (
    '40000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000001',
    7000,
    'income',
    1
  ),
  (
    '40000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000004',
    '30000000-0000-0000-0000-000000000002',
    -400,
    'spending',
    0
  ),
  (
    '40000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000005',
    '30000000-0000-0000-0000-000000000002',
    -250,
    'spending',
    1
  ),
  (
    '40000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000006',
    '30000000-0000-0000-0000-000000000003',
    -15,
    'spending',
    0
  )
on conflict (id) do update
set subsection_id = excluded.subsection_id,
    amount = excluded.amount,
    direction = excluded.direction,
    position = excluded.position,
    updated_at = now();

insert into public.transactions (
  id,
  user_id,
  source_transaction_id,
  transaction_date,
  merchant_name,
  transaction_name,
  amount,
  currency_code,
  is_pending,
  category,
  account_name
)
values
  (
    '50000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'local-salary-2026-08-01',
    date '2026-08-01',
    'Contoso Payroll',
    'Contoso Payroll Direct Deposit',
    7000,
    'USD',
    false,
    'Income',
    'Local Checking'
  ),
  (
    '50000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'local-groceries-2026-08-05',
    date '2026-08-05',
    'Local Market',
    'Local Market',
    -125.5,
    'USD',
    false,
    'Food and Drink',
    'Local Checking'
  ),
  (
    '50000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'local-restaurant-2026-08-08',
    date '2026-08-08',
    'Cedar Cafe',
    'Cedar Cafe',
    -42,
    'USD',
    false,
    'Food and Drink',
    'Local Credit Card'
  ),
  (
    '50000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'local-uncategorized-2026-08-10',
    date '2026-08-10',
    'Corner Shop',
    'Corner Shop',
    -18.75,
    'USD',
    false,
    'Shopping',
    'Local Checking'
  )
on conflict (id) do update
set transaction_date = excluded.transaction_date,
    merchant_name = excluded.merchant_name,
    transaction_name = excluded.transaction_name,
    amount = excluded.amount,
    currency_code = excluded.currency_code,
    is_pending = excluded.is_pending,
    category = excluded.category,
    account_name = excluded.account_name,
    imported_at = now();

insert into public.transaction_category_splits (
  id,
  user_id,
  transaction_id,
  category_id,
  amount
)
values
  (
    '60000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003',
    7000
  ),
  (
    '60000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000004',
    -125.5
  ),
  (
    '60000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    '50000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000005',
    -42
  )
on conflict (id) do update
set category_id = excluded.category_id,
    amount = excluded.amount,
    updated_at = now();
