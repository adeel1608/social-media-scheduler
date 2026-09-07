begin;

alter table public.post_targets add column row_version bigint not null default 0;
alter table public.connected_accounts add column credential_version bigint not null default 0;

create function app_private.advance_target_version()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.row_version := old.row_version + 1;
  return new;
end;
$$;
revoke all on function app_private.advance_target_version() from public, anon, authenticated;
create trigger post_targets_advance_version before update on public.post_targets
for each row execute function app_private.advance_target_version();

create function app_private.advance_credential_version()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.credential_version := old.credential_version + 1;
  return new;
end;
$$;
revoke all on function app_private.advance_credential_version() from public, anon, authenticated;
create trigger connected_accounts_advance_credential_version
before update of encrypted_access_token, encrypted_refresh_token, connection_status,
  authorization_context, authorization_generation on public.connected_accounts
for each row execute function app_private.advance_credential_version();

create function app_private.publication_target_authorized(
  t public.post_targets, p_owner_email text, p_live_enabled boolean,
  p_review_enabled boolean, p_reviewer_id uuid, p_reviewer_email text
)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    exists (select 1 from public.posts p
      join public.connected_accounts a on a.id = t.connected_account_id
      where p.id = t.post_id and p.owner_id = t.owner_id and a.owner_id = t.owner_id
        and a.platform = t.platform and a.connection_status = 'connected'
        and a.authorization_context = t.authorization_context
        and p.authorization_context = t.authorization_context
        and not exists (select 1 from public.account_disconnect_transactions d
          where d.account_id = a.id and d.state <> 'completed')
        and (
          (t.authorization_context = 'owner' and p_live_enabled
            and exists (select 1 from public.installation_settings s join auth.users u on u.id = s.owner_id
              where s.owner_id = t.owner_id and s.owner_email = p_owner_email
                and lower(u.email) = p_owner_email and u.deleted_at is null
                and (u.banned_until is null or u.banned_until <= now())))
          or (t.authorization_context = 'meta_review' and p_review_enabled
            and t.platform = 'instagram' and t.owner_id = p_reviewer_id
            and t.authorization_generation = app_private.current_review_generation(p_reviewer_id)
            and p.authorization_generation = t.authorization_generation
            and a.authorization_generation = t.authorization_generation
            and exists (select 1 from public.meta_review_authorization r
              where r.reviewer_user_id = p_reviewer_id and r.reviewer_email = p_reviewer_email))
        ))
    and cardinality(t.selected_media_ids) > 0
    and not exists (
      select 1 from unnest(t.selected_media_ids) selected_id
      where not exists (select 1 from public.post_media pm join public.media_assets m on m.id = pm.media_asset_id
        where pm.post_id = t.post_id and m.id = selected_id and m.owner_id = t.owner_id
          and m.deleted_at is null and m.upload_status = 'complete' and m.storage_provider = 'uploadthing'
          and m.authorization_context = t.authorization_context
          and (t.authorization_context = 'owner' or m.authorization_generation = t.authorization_generation)))
    and not exists (select 1 from public.post_media pm join public.media_assets m on m.id = pm.media_asset_id
      where pm.post_id = t.post_id and (m.owner_id <> t.owner_id
        or m.authorization_context <> t.authorization_context
        or (t.authorization_context = 'meta_review' and m.authorization_generation is distinct from t.authorization_generation)))
  , false)
$$;
revoke all on function app_private.publication_target_authorized(public.post_targets, text, boolean, boolean, uuid, text)
from public, anon, authenticated;

create function public.claim_publication_target(
  p_target_id uuid, p_lease_owner text, p_owner_email text, p_live_enabled boolean,
  p_review_enabled boolean, p_reviewer_id uuid, p_reviewer_email text,
  p_authorization_generation uuid default null
)
returns setof public.post_targets language plpgsql security definer set search_path = public, pg_temp
as $$
declare t public.post_targets;
begin
  if p_lease_owner is null or length(p_lease_owner) not between 1 and 128 then
    raise exception 'Invalid lease' using errcode = '22023';
  end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if not found or t.status not in ('queued', 'publishing', 'processing')
    or (t.lease_expires_at is not null and t.lease_expires_at > clock_timestamp()) then return; end if;
  if not app_private.publication_target_authorized(t, p_owner_email, p_live_enabled,
      p_review_enabled, p_reviewer_id, p_reviewer_email)
    or (t.authorization_context = 'meta_review'
      and t.authorization_generation is distinct from p_authorization_generation)
  then
    update public.post_targets set
      status = case when publish_request_sent_at is null then 'blocked_authorization'::public.target_status
        else 'needs_review'::public.target_status end,
      last_error_code = 'publication_authorization_unavailable',
      last_error_message = 'Current publication authorization could not be established.',
      lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = t.id;
    return;
  end if;
  -- An unacknowledged non-idempotent request cannot be retried on takeover.
  -- A known read-only polling or idempotent upload handle remains reconcilable.
  if t.platform_upload_state -> 'providerWrite' is not null
    or (t.publish_request_sent_at is not null
      and t.platform_upload_state ->> 'statusHandle' is null
      and t.platform_upload_state ->> 'encryptedUrl' is null) then
    update public.post_targets set status = 'needs_review',
      last_error_code = 'ambiguous_provider_acceptance',
      last_error_message = 'A previous provider request may have been accepted. Do not republish.',
      lease_owner = null, lease_expires_at = null, updated_at = now()
    where id = t.id;
    return;
  end if;
  return query update public.post_targets set lease_owner = p_lease_owner,
    lease_expires_at = clock_timestamp() + interval '10 minutes'
  where id = t.id returning *;
end;
$$;
revoke all on function public.claim_publication_target(uuid, text, text, boolean, boolean, uuid, text, uuid)
from public, anon, authenticated;
grant execute on function public.claim_publication_target(uuid, text, text, boolean, boolean, uuid, text, uuid) to service_role;

create function public.transition_publication_target(
  p_target_id uuid, p_lease_owner text, p_row_version bigint, p_expected_status public.target_status,
  p_expected_upload_state jsonb, p_context text, p_authorization_generation uuid,
  p_account_version bigint, p_patch jsonb, p_owner_email text, p_live_enabled boolean,
  p_review_enabled boolean, p_reviewer_id uuid, p_reviewer_email text
)
returns setof public.post_targets language plpgsql security definer set search_path = public, pg_temp
as $$
declare t public.post_targets; proposed public.post_targets;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_patch) k where k not in (
      'status', 'publish_request_sent_at', 'platform_upload_state', 'remote_content_id', 'remote_url',
      'last_error_code', 'last_error_message', 'published_at', 'updated_at', 'lease_owner', 'lease_expires_at'
    )) then raise exception 'Invalid publication transition' using errcode = '22023'; end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if not found or t.row_version <> p_row_version or t.lease_owner is distinct from p_lease_owner
    or t.lease_expires_at is null or t.lease_expires_at <= clock_timestamp()
    or t.status not in ('queued', 'publishing', 'processing') or t.status <> p_expected_status
    or t.platform_upload_state is distinct from p_expected_upload_state
    or t.authorization_context is distinct from p_context
    or t.authorization_generation is distinct from p_authorization_generation
    or not exists (select 1 from public.connected_accounts a where a.id = t.connected_account_id
      and a.credential_version = p_account_version)
    or not app_private.publication_target_authorized(t, p_owner_email, p_live_enabled,
      p_review_enabled, p_reviewer_id, p_reviewer_email)
  then return; end if;
  proposed := jsonb_populate_record(t, p_patch);
  if proposed.lease_owner is not null and proposed.lease_owner <> t.lease_owner then
    raise exception 'Cannot transfer a publication lease' using errcode = '22023';
  end if;
  if proposed.lease_expires_at > t.lease_expires_at then
    raise exception 'Cannot extend a publication lease' using errcode = '22023';
  end if;
  if t.publish_request_sent_at is not null and proposed.publish_request_sent_at is null then
    raise exception 'Cannot erase a publication marker' using errcode = '22023';
  end if;
  return query update public.post_targets set
    status = proposed.status, publish_request_sent_at = proposed.publish_request_sent_at,
    platform_upload_state = proposed.platform_upload_state, remote_content_id = proposed.remote_content_id,
    remote_url = proposed.remote_url, last_error_code = proposed.last_error_code,
    last_error_message = proposed.last_error_message, published_at = proposed.published_at,
    updated_at = now(), lease_owner = proposed.lease_owner, lease_expires_at = proposed.lease_expires_at
  where id = t.id returning *;
end;
$$;
revoke all on function public.transition_publication_target(uuid, text, bigint, public.target_status, jsonb, text, uuid, bigint, jsonb, text, boolean, boolean, uuid, text)
from public, anon, authenticated;
grant execute on function public.transition_publication_target(uuid, text, bigint, public.target_status, jsonb, text, uuid, bigint, jsonb, text, boolean, boolean, uuid, text) to service_role;

create function public.refresh_publication_credentials(
  p_target_id uuid, p_lease_owner text, p_row_version bigint, p_expected_status public.target_status,
  p_expected_upload_state jsonb, p_context text, p_authorization_generation uuid,
  p_account_version bigint, p_patch jsonb, p_owner_email text, p_live_enabled boolean,
  p_review_enabled boolean, p_reviewer_id uuid, p_reviewer_email text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.post_targets; a public.connected_accounts; proposed public.connected_accounts;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or exists (
    select 1 from jsonb_object_keys(p_patch) k where k not in (
      'encrypted_access_token', 'access_token_nonce', 'encrypted_refresh_token', 'refresh_token_nonce',
      'encryption_key_version', 'token_expires_at', 'metadata', 'connection_status', 'updated_at'
    )) then raise exception 'Invalid credential transition' using errcode = '22023'; end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if not found then return null; end if;
  select * into a from public.connected_accounts where id = t.connected_account_id for update;
  select * into t from public.transition_publication_target(p_target_id, p_lease_owner, p_row_version,
    p_expected_status, p_expected_upload_state, p_context, p_authorization_generation, p_account_version,
    '{}'::jsonb, p_owner_email, p_live_enabled, p_review_enabled, p_reviewer_id, p_reviewer_email);
  if not found then return null; end if;
  proposed := jsonb_populate_record(a, p_patch);
  update public.connected_accounts set encrypted_access_token = proposed.encrypted_access_token,
    access_token_nonce = proposed.access_token_nonce, encrypted_refresh_token = proposed.encrypted_refresh_token,
    refresh_token_nonce = proposed.refresh_token_nonce, encryption_key_version = proposed.encryption_key_version,
    token_expires_at = proposed.token_expires_at, metadata = proposed.metadata,
    connection_status = proposed.connection_status, updated_at = now()
  where id = a.id returning * into a;
  return jsonb_build_object('target', to_jsonb(t), 'credential_version', a.credential_version);
end;
$$;
revoke all on function public.refresh_publication_credentials(uuid, text, bigint, public.target_status, jsonb, text, uuid, bigint, jsonb, text, boolean, boolean, uuid, text)
from public, anon, authenticated;
grant execute on function public.refresh_publication_credentials(uuid, text, bigint, public.target_status, jsonb, text, uuid, bigint, jsonb, text, boolean, boolean, uuid, text) to service_role;

commit;
