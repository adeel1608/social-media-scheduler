-- Forward-only repair: modern PostgREST and both elevated server-key styles.
-- Existing transaction semantics are unchanged; authorization is the EXECUTE ACL.
begin;

create or replace function public.begin_account_disconnect(
  p_account_id uuid,
  p_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transaction_row public.account_disconnect_transactions;
begin
  -- EXECUTE ACLs authorize the caller before SECURITY DEFINER switches role.

  perform 1
  from public.connected_accounts account
  where account.id = p_account_id
    and account.owner_id = p_owner_id
  for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0001';
  end if;

  select candidate.*
  into transaction_row
  from public.account_disconnect_transactions candidate
  where candidate.account_id = p_account_id
    and candidate.owner_id = p_owner_id
  for update;

  if transaction_row.account_id is null then
    insert into public.account_disconnect_transactions (account_id, owner_id)
    values (p_account_id, p_owner_id)
    on conflict (account_id) do nothing
    returning * into transaction_row;

    if transaction_row.account_id is null then
      select candidate.*
      into transaction_row
      from public.account_disconnect_transactions candidate
      where candidate.account_id = p_account_id
        and candidate.owner_id = p_owner_id
      for update;
    end if;
  end if;

  if transaction_row.state <> 'completed'
     and transaction_row.expires_at <= now() then
    update public.account_disconnect_transactions candidate
    set operation_id = gen_random_uuid(),
        expires_at = now() + interval '10 minutes',
        updated_at = now()
    where candidate.account_id = p_account_id
    returning * into transaction_row;
  end if;

  return jsonb_build_object(
    'account_id', transaction_row.account_id,
    'operation_id', transaction_row.operation_id,
    'state', transaction_row.state,
    'expires_at', transaction_row.expires_at,
    'provider_outcome', transaction_row.provider_outcome
  );
end;
$$;

create or replace function public.mark_account_disconnect_revocation_started(
  p_account_id uuid,
  p_owner_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transaction_row public.account_disconnect_transactions;
  should_revoke boolean := false;
begin
  -- EXECUTE ACLs authorize the caller before SECURITY DEFINER switches role.
  select candidate.*
  into transaction_row
  from public.account_disconnect_transactions candidate
  where candidate.account_id = p_account_id
    and candidate.owner_id = p_owner_id
    and candidate.operation_id = p_operation_id
  for update;
  if transaction_row.account_id is null then
    raise exception 'disconnect transaction not found' using errcode = 'P0001';
  end if;
  if transaction_row.expires_at <= now() then
    raise exception 'disconnect transaction expired' using errcode = 'P0001';
  end if;

  if transaction_row.state = 'prepared' then
    update public.account_disconnect_transactions candidate
    set state = 'revocation_started',
        provider_request_sent_at = now(),
        updated_at = now()
    where candidate.account_id = p_account_id
    returning * into transaction_row;
    should_revoke := true;
  end if;

  return jsonb_build_object(
    'account_id', transaction_row.account_id,
    'operation_id', transaction_row.operation_id,
    'state', transaction_row.state,
    'expires_at', transaction_row.expires_at,
    'provider_outcome', transaction_row.provider_outcome,
    'should_revoke', should_revoke
  );
end;
$$;

create or replace function public.record_account_disconnect_revocation(
  p_account_id uuid,
  p_owner_id uuid,
  p_operation_id uuid,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transaction_row public.account_disconnect_transactions;
begin
  -- EXECUTE ACLs authorize the caller before SECURITY DEFINER switches role.
  if p_outcome not in ('provider_revoked', 'revocation_uncertain') then
    raise exception 'invalid revocation outcome' using errcode = 'P0001';
  end if;

  update public.account_disconnect_transactions candidate
  set state = p_outcome,
      provider_outcome = case
        when p_outcome = 'provider_revoked' then 'confirmed'
        else 'uncertain'
      end,
      provider_result_recorded_at = now(),
      updated_at = now()
  where candidate.account_id = p_account_id
    and candidate.owner_id = p_owner_id
    and candidate.operation_id = p_operation_id
    and candidate.state = 'revocation_started'
  returning * into transaction_row;

  if transaction_row.account_id is null then
    select candidate.*
    into transaction_row
    from public.account_disconnect_transactions candidate
    where candidate.account_id = p_account_id
      and candidate.owner_id = p_owner_id
      and candidate.operation_id = p_operation_id;
  end if;
  if transaction_row.account_id is null then
    raise exception 'disconnect transaction not found' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'account_id', transaction_row.account_id,
    'operation_id', transaction_row.operation_id,
    'state', transaction_row.state,
    'expires_at', transaction_row.expires_at,
    'provider_outcome', transaction_row.provider_outcome
  );
end;
$$;

create or replace function public.complete_account_disconnect(
  p_account_id uuid,
  p_owner_id uuid,
  p_operation_id uuid,
  p_provider_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  transaction_row public.account_disconnect_transactions;
begin
  -- EXECUTE ACLs authorize the caller before SECURITY DEFINER switches role.

  select candidate.*
  into transaction_row
  from public.account_disconnect_transactions candidate
  where candidate.account_id = p_account_id
    and candidate.owner_id = p_owner_id
    and candidate.operation_id = p_operation_id
  for update;
  if transaction_row.account_id is null then
    raise exception 'disconnect transaction not found' using errcode = 'P0001';
  end if;
  if transaction_row.state = 'completed' then
    return jsonb_build_object(
      'account_id', transaction_row.account_id,
      'operation_id', transaction_row.operation_id,
      'state', transaction_row.state,
      'expires_at', transaction_row.expires_at,
      'provider_outcome', transaction_row.provider_outcome,
      'completed_now', false
    );
  end if;
  if transaction_row.expires_at <= now() then
    raise exception 'disconnect transaction expired' using errcode = 'P0001';
  end if;
  if transaction_row.state not in (
    'revocation_started',
    'provider_revoked',
    'revocation_uncertain'
  ) then
    raise exception 'provider revocation has not started' using errcode = 'P0001';
  end if;

  update public.connected_accounts account
  set connection_status = 'disconnected',
      encrypted_access_token = 'revoked',
      access_token_nonce = 'revoked',
      encrypted_refresh_token = null,
      refresh_token_nonce = null,
      updated_at = now()
  where account.id = p_account_id
    and account.owner_id = p_owner_id;
  if not found then
    raise exception 'account not found' using errcode = 'P0001';
  end if;

  update public.account_disconnect_transactions candidate
  set state = 'completed',
      provider_outcome = case
        when p_provider_confirmed or transaction_row.state = 'provider_revoked'
          then 'confirmed'
        else coalesce(transaction_row.provider_outcome, 'uncertain')
      end,
      completed_at = now(),
      updated_at = now()
  where candidate.account_id = p_account_id
  returning * into transaction_row;

  return jsonb_build_object(
    'account_id', transaction_row.account_id,
    'operation_id', transaction_row.operation_id,
    'state', transaction_row.state,
    'expires_at', transaction_row.expires_at,
    'provider_outcome', transaction_row.provider_outcome,
    'completed_now', true
  );
end;
$$;

revoke all on function public.begin_account_disconnect(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.begin_account_disconnect(uuid, uuid) to service_role;

revoke all on function public.mark_account_disconnect_revocation_started(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.mark_account_disconnect_revocation_started(uuid, uuid, uuid) to service_role;

revoke all on function public.record_account_disconnect_revocation(uuid, uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.record_account_disconnect_revocation(uuid, uuid, uuid, text) to service_role;

revoke all on function public.complete_account_disconnect(uuid, uuid, uuid, boolean)
from public, anon, authenticated;
grant execute on function public.complete_account_disconnect(uuid, uuid, uuid, boolean) to service_role;

commit;
