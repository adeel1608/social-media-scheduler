begin;

create table if not exists public.account_disconnect_transactions (
  account_id uuid primary key references public.connected_accounts(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null unique default gen_random_uuid(),
  state text not null default 'prepared'
    check (state in ('prepared', 'revocation_started', 'provider_revoked', 'revocation_uncertain', 'completed')),
  provider_outcome text
    check (provider_outcome in ('confirmed', 'uncertain')),
  expires_at timestamptz not null default now() + interval '10 minutes',
  provider_request_sent_at timestamptz,
  provider_result_recorded_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists account_disconnect_owner_state_idx
on public.account_disconnect_transactions (owner_id, state, expires_at);

create or replace function app_private.clear_account_disconnect_on_reconnect()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.connection_status = 'connected'
     and new.encrypted_access_token is distinct from old.encrypted_access_token then
    delete from public.account_disconnect_transactions as disconnect_record
    where disconnect_record.account_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function app_private.clear_account_disconnect_on_reconnect()
from public, anon, authenticated;

drop trigger if exists connected_accounts_clear_disconnect_on_reconnect
on public.connected_accounts;
create trigger connected_accounts_clear_disconnect_on_reconnect
after update of encrypted_access_token, connection_status
on public.connected_accounts
for each row execute function app_private.clear_account_disconnect_on_reconnect();

alter table public.account_disconnect_transactions enable row level security;

drop policy if exists account_disconnect_owner_select
on public.account_disconnect_transactions;
create policy account_disconnect_owner_select
on public.account_disconnect_transactions
for select to authenticated
using (app_private.is_owner(owner_id));

revoke all on table public.account_disconnect_transactions
from public, anon, authenticated;
grant select on table public.account_disconnect_transactions to authenticated;
grant all on table public.account_disconnect_transactions to service_role;

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
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

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
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

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
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
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
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

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

create or replace function public.verify_phase_2b_schema()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
      then jsonb_build_object('ready', false)
    else jsonb_build_object(
      'ready',
      to_regclass('public.account_disconnect_transactions') is not null
      and to_regprocedure('public.begin_account_disconnect(uuid,uuid)') is not null
      and to_regprocedure('public.mark_account_disconnect_revocation_started(uuid,uuid,uuid)') is not null
      and to_regprocedure('public.record_account_disconnect_revocation(uuid,uuid,uuid,text)') is not null
      and to_regprocedure('public.complete_account_disconnect(uuid,uuid,uuid,boolean)') is not null
      and exists (
        select 1
        from pg_trigger
        where tgname = 'connected_accounts_clear_disconnect_on_reconnect'
          and not tgisinternal
      )
    )
  end;
$$;

revoke all on function public.begin_account_disconnect(uuid, uuid)
from public, anon, authenticated;
revoke all on function public.mark_account_disconnect_revocation_started(uuid, uuid, uuid)
from public, anon, authenticated;
revoke all on function public.record_account_disconnect_revocation(uuid, uuid, uuid, text)
from public, anon, authenticated;
revoke all on function public.complete_account_disconnect(uuid, uuid, uuid, boolean)
from public, anon, authenticated;
revoke all on function public.verify_phase_2b_schema()
from public, anon, authenticated;

grant execute on function public.begin_account_disconnect(uuid, uuid)
to service_role;
grant execute on function public.mark_account_disconnect_revocation_started(uuid, uuid, uuid)
to service_role;
grant execute on function public.record_account_disconnect_revocation(uuid, uuid, uuid, text)
to service_role;
grant execute on function public.complete_account_disconnect(uuid, uuid, uuid, boolean)
to service_role;
grant execute on function public.verify_phase_2b_schema()
to service_role;

commit;
