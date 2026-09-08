begin;

-- Provider redirects cannot carry the current Postline bearer token. Keep the
-- returned authorization code encrypted until the initiating authenticated
-- Supabase session proves that it is still the active browser session.
alter table public.oauth_states
  add column callback_received_at timestamptz,
  add column completion_consumed_at timestamptz,
  add column pending_authorization_code text,
  add column pending_authorization_code_nonce text,
  add column pending_authorization_code_key_version text,
  add column pending_completion_handle_hash text;

alter table public.oauth_states
  add constraint oauth_states_pending_completion_consistency check (
    (
      pending_authorization_code is null
      and pending_authorization_code_nonce is null
      and pending_authorization_code_key_version is null
      and pending_completion_handle_hash is null
    )
    or
    (
      callback_received_at is not null
      and pending_authorization_code is not null
      and pending_authorization_code_nonce is not null
      and pending_authorization_code_key_version is not null
      and pending_completion_handle_hash is not null
    )
  );

create unique index oauth_states_pending_completion_handle_idx
  on public.oauth_states (pending_completion_handle_hash)
  where pending_completion_handle_hash is not null
    and completion_consumed_at is null;

create index oauth_states_owner_session_pending_idx
  on public.oauth_states (owner_id, auth_session_id, expires_at)
  where completion_consumed_at is null;

create function public.record_bound_oauth_callback(
  p_state_hash text,
  p_browser_binding_hash text,
  p_platform public.social_platform,
  p_authorization_code text,
  p_authorization_code_nonce text,
  p_authorization_code_key_version text,
  p_completion_handle_hash text,
  p_owner_email text,
  p_review_enabled boolean,
  p_reviewer_id uuid,
  p_reviewer_email text,
  p_redirect_uri text
)
returns setof public.oauth_states
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.oauth_states;
begin
  if p_authorization_code is null
    or length(p_authorization_code) not between 24 and 8192
    or p_authorization_code_nonce is null
    or length(p_authorization_code_nonce) not between 12 and 256
    or p_authorization_code_key_version is null
    or length(p_authorization_code_key_version) not between 1 and 64
    or p_completion_handle_hash !~ '^[0-9a-f]{64}$'
  then
    return;
  end if;

  select * into s
  from public.oauth_states
  where state_hash = p_state_hash and platform = p_platform
  for update;

  if not found
    or s.consumed_at is not null
    or s.callback_received_at is not null
    or s.browser_binding_hash is distinct from p_browser_binding_hash
    or not app_private.oauth_transaction_authorized(
      s,
      p_owner_email,
      p_review_enabled,
      p_reviewer_id,
      p_reviewer_email,
      p_redirect_uri
    )
  then
    return;
  end if;

  return query
  update public.oauth_states
  set consumed_at = clock_timestamp(),
      callback_received_at = clock_timestamp(),
      pending_authorization_code = p_authorization_code,
      pending_authorization_code_nonce = p_authorization_code_nonce,
      pending_authorization_code_key_version = p_authorization_code_key_version,
      pending_completion_handle_hash = p_completion_handle_hash
  where id = s.id and expires_at > clock_timestamp()
  returning *;
end;
$$;

alter function public.record_bound_oauth_callback(
  text, text, public.social_platform, text, text, text, text,
  text, boolean, uuid, text, text
) owner to postgres;
revoke all on function public.record_bound_oauth_callback(
  text, text, public.social_platform, text, text, text, text,
  text, boolean, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.record_bound_oauth_callback(
  text, text, public.social_platform, text, text, text, text,
  text, boolean, uuid, text, text
) to service_role;

create function public.consume_oauth_completion(
  p_completion_handle_hash text,
  p_browser_binding_hash text,
  p_platform public.social_platform,
  p_current_owner_id uuid,
  p_current_email text,
  p_current_auth_session_id uuid,
  p_owner_email text,
  p_review_enabled boolean,
  p_reviewer_id uuid,
  p_reviewer_email text,
  p_redirect_uri text
)
returns setof public.oauth_states
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.oauth_states;
begin
  if p_completion_handle_hash !~ '^[0-9a-f]{64}$'
    or p_browser_binding_hash !~ '^[0-9a-f]{64}$'
    or p_current_email is null
    or p_current_email <> lower(trim(p_current_email))
  then
    return;
  end if;

  select * into s
  from public.oauth_states
  where pending_completion_handle_hash = p_completion_handle_hash
    and platform = p_platform
  for update;

  if not found
    or s.callback_received_at is null
    or s.completion_consumed_at is not null
    or s.credentials_persisted_at is not null
    or s.pending_authorization_code is null
    or s.pending_authorization_code_nonce is null
    or s.pending_authorization_code_key_version is null
    or s.owner_id is distinct from p_current_owner_id
    or s.initiating_email is distinct from p_current_email
    or s.auth_session_id is distinct from p_current_auth_session_id
    or s.browser_binding_hash is distinct from p_browser_binding_hash
    or not app_private.oauth_transaction_authorized(
      s,
      p_owner_email,
      p_review_enabled,
      p_reviewer_id,
      p_reviewer_email,
      p_redirect_uri
    )
  then
    return;
  end if;

  return query
  update public.oauth_states
  set completion_consumed_at = clock_timestamp()
  where id = s.id
    and completion_consumed_at is null
    and expires_at > clock_timestamp()
  returning *;
end;
$$;

alter function public.consume_oauth_completion(
  text, text, public.social_platform, uuid, text, uuid,
  text, boolean, uuid, text, text
) owner to postgres;
revoke all on function public.consume_oauth_completion(
  text, text, public.social_platform, uuid, text, uuid,
  text, boolean, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.consume_oauth_completion(
  text, text, public.social_platform, uuid, text, uuid,
  text, boolean, uuid, text, text
) to service_role;

create function public.cancel_pending_oauth(
  p_owner_id uuid,
  p_auth_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  update public.oauth_states
  set consumed_at = coalesce(consumed_at, clock_timestamp()),
      completion_consumed_at = coalesce(completion_consumed_at, clock_timestamp()),
      pending_authorization_code = null,
      pending_authorization_code_nonce = null,
      pending_authorization_code_key_version = null,
      pending_completion_handle_hash = null
  where owner_id = p_owner_id
    and auth_session_id = p_auth_session_id
    and credentials_persisted_at is null
    and completion_consumed_at is null;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

alter function public.cancel_pending_oauth(uuid, uuid) owner to postgres;
revoke all on function public.cancel_pending_oauth(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_pending_oauth(uuid, uuid)
  to service_role;

create function public.expire_pending_oauth_states(p_limit integer default 250)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  with expired as (
    select id
    from public.oauth_states
    where expires_at <= clock_timestamp()
      and credentials_persisted_at is null
      and (
        completion_consumed_at is null
        or pending_authorization_code is not null
      )
    order by expires_at, id
    for update skip locked
    limit greatest(0, least(p_limit, 1000))
  )
  update public.oauth_states s
  set consumed_at = coalesce(s.consumed_at, clock_timestamp()),
      completion_consumed_at = coalesce(s.completion_consumed_at, clock_timestamp()),
      pending_authorization_code = null,
      pending_authorization_code_nonce = null,
      pending_authorization_code_key_version = null,
      pending_completion_handle_hash = null
  from expired
  where s.id = expired.id;
  get diagnostics affected = row_count;
  return affected;
end;
$$;

alter function public.expire_pending_oauth_states(integer) owner to postgres;
revoke all on function public.expire_pending_oauth_states(integer)
  from public, anon, authenticated;
grant execute on function public.expire_pending_oauth_states(integer)
  to service_role;

-- The old single-step callback RPC must fail closed while the schema is ahead
-- of the Worker during a migration-first rollout.
revoke all on function public.consume_bound_oauth_state(
  text, text, public.social_platform, text, boolean, uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function public.persist_bound_oauth_account(
  p_state_id uuid,
  p_browser_binding_hash text,
  p_account jsonb,
  p_owner_email text,
  p_review_enabled boolean,
  p_reviewer_id uuid,
  p_reviewer_email text,
  p_redirect_uri text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.oauth_states;
  a public.connected_accounts;
  account_id uuid;
begin
  select * into s
  from public.oauth_states
  where id = p_state_id
  for update;

  if not found
    or s.callback_received_at is null
    or s.completion_consumed_at is null
    or s.credentials_persisted_at is not null
    or s.browser_binding_hash is distinct from p_browser_binding_hash
    or not app_private.oauth_transaction_authorized(
      s,
      p_owner_email,
      p_review_enabled,
      p_reviewer_id,
      p_reviewer_email,
      p_redirect_uri
    )
  then
    raise exception 'OAuth transaction is no longer authorized'
      using errcode = '42501';
  end if;

  a := jsonb_populate_record(null::public.connected_accounts, p_account);
  if a.remote_account_id is null
    or length(a.remote_account_id) not between 1 and 256
  then
    raise exception 'Invalid account identity' using errcode = '22023';
  end if;

  insert into public.connected_accounts (
    owner_id,
    platform,
    authorization_context,
    authorization_generation,
    remote_account_id,
    username,
    encrypted_access_token,
    access_token_nonce,
    encrypted_refresh_token,
    refresh_token_nonce,
    encryption_key_version,
    scopes,
    token_expires_at,
    connection_status,
    approval_state,
    metadata
  ) values (
    s.owner_id,
    s.platform,
    s.authorization_context,
    s.authorization_generation,
    a.remote_account_id,
    a.username,
    a.encrypted_access_token,
    a.access_token_nonce,
    a.encrypted_refresh_token,
    a.refresh_token_nonce,
    a.encryption_key_version,
    coalesce(a.scopes, '{}'),
    a.token_expires_at,
    'connected',
    a.approval_state,
    coalesce(a.metadata, '{}')
  )
  on conflict (owner_id, platform, remote_account_id) do update set
    authorization_generation = excluded.authorization_generation,
    username = excluded.username,
    encrypted_access_token = excluded.encrypted_access_token,
    access_token_nonce = excluded.access_token_nonce,
    encrypted_refresh_token = excluded.encrypted_refresh_token,
    refresh_token_nonce = excluded.refresh_token_nonce,
    encryption_key_version = excluded.encryption_key_version,
    scopes = excluded.scopes,
    token_expires_at = excluded.token_expires_at,
    connection_status = excluded.connection_status,
    approval_state = excluded.approval_state,
    metadata = excluded.metadata,
    updated_at = now()
  where connected_accounts.authorization_context = excluded.authorization_context
  returning id into account_id;

  if account_id is null then
    raise exception 'Conflicting account context' using errcode = '42501';
  end if;

  update public.oauth_states
  set credentials_persisted_at = clock_timestamp(),
      pending_authorization_code = null,
      pending_authorization_code_nonce = null,
      pending_authorization_code_key_version = null,
      pending_completion_handle_hash = null
  where id = s.id;

  return jsonb_build_object('id', account_id);
end;
$$;

alter function public.persist_bound_oauth_account(
  uuid, text, jsonb, text, boolean, uuid, text, text
) owner to postgres;
revoke all on function public.persist_bound_oauth_account(
  uuid, text, jsonb, text, boolean, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.persist_bound_oauth_account(
  uuid, text, jsonb, text, boolean, uuid, text, text
) to service_role;

-- Reviewer revocation, Auth changes, generation replacement, and explicit
-- disablement invalidate callback and completion material together.
create or replace function app_private.invalidate_review_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.oauth_states
  set consumed_at = coalesce(consumed_at, now()),
      completion_consumed_at = coalesce(completion_consumed_at, now()),
      pending_authorization_code = null,
      pending_authorization_code_nonce = null,
      pending_authorization_code_key_version = null,
      pending_completion_handle_hash = null
  where authorization_context = 'meta_review'
    and (
      not new.enabled
      or authorization_generation is distinct from new.generation
    );

  update public.post_targets
  set status = case
        when publish_request_sent_at is not null
          then 'needs_review'::public.target_status
        else 'blocked_authorization'::public.target_status
      end,
      last_error_code = 'meta_review_authorization_revoked',
      last_error_message = 'The review authorization is no longer valid.',
      lease_owner = null,
      lease_expires_at = null,
      updated_at = now()
  where authorization_context = 'meta_review'
    and status in (
      'scheduled',
      'queued',
      'publishing',
      'processing',
      'blocked_authorization'
    )
    and (
      not new.enabled
      or authorization_generation is distinct from new.generation
    );
  return new;
end;
$$;

alter function app_private.invalidate_review_work() owner to postgres;
revoke all on function app_private.invalidate_review_work()
  from public, anon, authenticated, service_role;

commit;
