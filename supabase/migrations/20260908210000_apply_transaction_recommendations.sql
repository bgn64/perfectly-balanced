create or replace function public.apply_transaction_recommendations(
  p_transaction_id uuid,
  p_category_id uuid default null,
  p_is_ignored boolean default null,
  p_expected_is_ignored boolean default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_transaction_amount numeric;
  v_currency_code text;
  v_current_is_ignored boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if p_category_id is null and p_is_ignored is null then
    raise exception 'At least one recommendation is required';
  end if;

  if p_is_ignored is not null and p_expected_is_ignored is null then
    raise exception 'The expected ignored state is required';
  end if;

  select amount, currency_code, is_ignored
  into v_transaction_amount, v_currency_code, v_current_is_ignored
  from public.transactions
  where id = p_transaction_id
    and user_id = v_user_id
  for update;

  if not found then
    raise exception 'Transaction was not found';
  end if;

  if p_category_id is not null then
    if v_currency_code is distinct from 'USD' then
      raise exception 'Only USD transactions can be categorized';
    end if;

    if not exists (
      select 1
      from public.categories
      where id = p_category_id
        and user_id = v_user_id
    ) then
      raise exception 'The recommended category was not found';
    end if;

    if exists (
      select 1
      from public.transaction_category_splits
      where transaction_id = p_transaction_id
        and user_id = v_user_id
    ) then
      raise exception 'Transaction categories changed; refresh recommendations';
    end if;

    insert into public.transaction_category_splits (
      user_id,
      transaction_id,
      category_id,
      amount
    )
    values (
      v_user_id,
      p_transaction_id,
      p_category_id,
      v_transaction_amount
    );
  end if;

  if p_is_ignored is not null then
    if v_current_is_ignored is distinct from p_expected_is_ignored then
      raise exception 'Transaction status changed; refresh recommendations';
    end if;

    update public.transactions
    set is_ignored = p_is_ignored
    where id = p_transaction_id
      and user_id = v_user_id;
  end if;
end;
$$;

revoke all on function public.apply_transaction_recommendations(
  uuid,
  uuid,
  boolean,
  boolean
) from public, anon, authenticated;
grant execute on function public.apply_transaction_recommendations(
  uuid,
  uuid,
  boolean,
  boolean
) to authenticated;
