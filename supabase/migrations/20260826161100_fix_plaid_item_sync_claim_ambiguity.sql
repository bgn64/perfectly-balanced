create or replace function public.claim_plaid_item_sync(
  p_item_id uuid
)
returns table (
  item_id uuid,
  plaid_item_id text,
  access_token text,
  sync_cursor text
)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'claim_plaid_item_sync is restricted to the service role';
  end if;

  return query
  with claimed as (
    update public.plaid_items as item
    set sync_started_at = now(),
        updated_at = now(),
        last_error_code = null
    where item.id = p_item_id
      and item.vault_secret_id is not null
      and item.status <> 'disconnected'
      and (
        item.sync_started_at is null
        or item.sync_started_at < now() - interval '10 minutes'
      )
    returning
      item.id,
      item.plaid_item_id,
      item.vault_secret_id,
      item.sync_cursor
  )
  select
    claimed.id,
    claimed.plaid_item_id,
    secrets.decrypted_secret,
    claimed.sync_cursor
  from claimed
  join vault.decrypted_secrets as secrets
    on secrets.id = claimed.vault_secret_id;
end;
$$;
