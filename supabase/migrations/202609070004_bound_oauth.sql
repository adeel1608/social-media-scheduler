begin;

alter table public.oauth_states add column credentials_persisted_at timestamptz;

-- Fail closed on conflicting historical identities rather than deleting or
-- silently choosing one. Operators must inspect any such conflict separately.
create unique index connected_accounts_instagram_identity_unique
on public.connected_accounts(platform, remote_account_id) where platform = 'instagram';

create function app_private.oauth_transaction_authorized(
  s public.oauth_states, p_owner_email text, p_review_enabled boolean,
  p_reviewer_id uuid, p_reviewer_email text, p_redirect_uri text
)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(s.browser_binding_hash is not null and s.auth_session_id is not null
    and s.expires_at > now() and s.redirect_uri = p_redirect_uri
    and exists (select 1 from auth.users u join auth.sessions session on session.user_id = u.id
      where u.id = s.owner_id and session.id = s.auth_session_id
        and lower(u.email) = s.initiating_email and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= now())
        and (session.not_after is null or session.not_after > now()))
    and ((s.authorization_context = 'owner' and s.initiating_email = p_owner_email
      and exists (select 1 from public.installation_settings i where i.owner_id = s.owner_id and i.owner_email = p_owner_email))
    or (s.authorization_context = 'meta_review' and p_review_enabled and s.platform = 'instagram'
      and s.owner_id = p_reviewer_id and s.initiating_email = p_reviewer_email
      and s.authorization_generation = app_private.current_review_generation(p_reviewer_id))), false)
$$;
revoke all on function app_private.oauth_transaction_authorized(public.oauth_states, text, boolean, uuid, text, text)
from public, anon, authenticated;

create function public.consume_bound_oauth_state(
  p_state_hash text, p_browser_binding_hash text, p_platform public.social_platform,
  p_owner_email text, p_review_enabled boolean, p_reviewer_id uuid,
  p_reviewer_email text, p_redirect_uri text
)
returns setof public.oauth_states language plpgsql security definer set search_path = public, pg_temp
as $$
declare s public.oauth_states;
begin
  select * into s from public.oauth_states
  where state_hash = p_state_hash and platform = p_platform for update;
  if not found or s.consumed_at is not null
    or s.browser_binding_hash is distinct from p_browser_binding_hash
    or not app_private.oauth_transaction_authorized(s, p_owner_email, p_review_enabled,
      p_reviewer_id, p_reviewer_email, p_redirect_uri) then return; end if;
  return query update public.oauth_states set consumed_at = clock_timestamp()
  where id = s.id and expires_at > clock_timestamp() returning *;
end;
$$;
revoke all on function public.consume_bound_oauth_state(text, text, public.social_platform, text, boolean, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.consume_bound_oauth_state(text, text, public.social_platform, text, boolean, uuid, text, text) to service_role;

create function public.persist_bound_oauth_account(
  p_state_id uuid, p_browser_binding_hash text, p_account jsonb,
  p_owner_email text, p_review_enabled boolean, p_reviewer_id uuid,
  p_reviewer_email text, p_redirect_uri text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare s public.oauth_states; a public.connected_accounts; account_id uuid;
begin
  select * into s from public.oauth_states where id = p_state_id for update;
  if not found or s.consumed_at is null or s.credentials_persisted_at is not null
    or s.browser_binding_hash is distinct from p_browser_binding_hash
    or not app_private.oauth_transaction_authorized(s, p_owner_email, p_review_enabled,
      p_reviewer_id, p_reviewer_email, p_redirect_uri)
  then raise exception 'OAuth transaction is no longer authorized' using errcode = '42501'; end if;
  a := jsonb_populate_record(null::public.connected_accounts, p_account);
  if a.remote_account_id is null or length(a.remote_account_id) not between 1 and 256 then
    raise exception 'Invalid account identity' using errcode = '22023';
  end if;
  -- Unique index resolves simultaneous owner/reviewer connections atomically.
  -- The WHERE clause also rejects context changes for an existing same-owner row.
  insert into public.connected_accounts (
    owner_id, platform, authorization_context, authorization_generation, remote_account_id, username,
    encrypted_access_token, access_token_nonce, encrypted_refresh_token, refresh_token_nonce,
    encryption_key_version, scopes, token_expires_at, connection_status, approval_state, metadata
  ) values (
    s.owner_id, s.platform, s.authorization_context, s.authorization_generation, a.remote_account_id, a.username,
    a.encrypted_access_token, a.access_token_nonce, a.encrypted_refresh_token, a.refresh_token_nonce,
    a.encryption_key_version, coalesce(a.scopes, '{}'), a.token_expires_at, 'connected', a.approval_state, coalesce(a.metadata, '{}')
  ) on conflict (owner_id, platform, remote_account_id) do update set
    authorization_generation = excluded.authorization_generation, username = excluded.username,
    encrypted_access_token = excluded.encrypted_access_token, access_token_nonce = excluded.access_token_nonce,
    encrypted_refresh_token = excluded.encrypted_refresh_token, refresh_token_nonce = excluded.refresh_token_nonce,
    encryption_key_version = excluded.encryption_key_version, scopes = excluded.scopes,
    token_expires_at = excluded.token_expires_at, connection_status = excluded.connection_status,
    approval_state = excluded.approval_state, metadata = excluded.metadata, updated_at = now()
  where connected_accounts.authorization_context = excluded.authorization_context
  returning id into account_id;
  if account_id is null then raise exception 'Conflicting account context' using errcode = '42501'; end if;
  update public.oauth_states set credentials_persisted_at = clock_timestamp() where id = s.id;
  return jsonb_build_object('id', account_id);
end;
$$;
revoke all on function public.persist_bound_oauth_account(uuid, text, jsonb, text, boolean, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.persist_bound_oauth_account(uuid, text, jsonb, text, boolean, uuid, text, text) to service_role;

commit;
