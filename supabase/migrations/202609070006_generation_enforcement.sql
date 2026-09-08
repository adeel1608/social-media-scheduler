begin;

-- Preserve existing owner scheduling; reviewer scheduling uses its explicitly
-- scoped, generation-aware claimant below, never the owner claimant.
create or replace function public.claim_due_targets(
  p_worker_id text,
  p_limit integer default 100,
  p_lease_seconds integer default 300
)
returns setof public.post_targets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.post_targets target
  set status = 'blocked_authorization', updated_at = now()
  where target.authorization_context = 'owner' and target.status = 'scheduled'
    and target.scheduled_at_utc <= now()
    and not exists (
      select 1 from public.connected_accounts account
      where account.id = target.connected_account_id
        and account.owner_id = target.owner_id
        and account.platform = target.platform
        and account.connection_status = 'connected'
        and (
          account.token_expires_at is null
          or account.token_expires_at > now() + interval '60 seconds'
          or account.encrypted_refresh_token is not null
          or account.platform = 'instagram'
        )
        and (
          (
            target.authorization_context = 'meta_review'
            and target.platform = 'instagram'
            and account.authorization_context = 'meta_review'
          )
          or (
            target.authorization_context = 'owner'
            and account.authorization_context = 'owner'
            and (
              account.approval_state in ('approved', 'not_required')
              or (target.platform = 'tiktok' and target.metadata ->> 'privacyLevel' = 'SELF_ONLY')
              or (target.platform = 'youtube' and target.metadata ->> 'privacyStatus' = 'private')
            )
          )
        )
    );

  update public.post_targets target
  set status = 'scheduled', updated_at = now()
  where target.authorization_context = 'owner' and target.status = 'blocked_authorization'
    and target.scheduled_at_utc <= now()
    and coalesce(target.last_error_code, '') not in (
      'meta_review_access_disabled',
      'meta_review_identity_mismatch'
    )
    and exists (
      select 1 from public.connected_accounts account
      where account.id = target.connected_account_id
        and account.owner_id = target.owner_id
        and account.platform = target.platform
        and account.connection_status = 'connected'
        and (
          account.token_expires_at is null
          or account.token_expires_at > now() + interval '60 seconds'
          or account.encrypted_refresh_token is not null
          or account.platform = 'instagram'
        )
        and (
          (
            target.authorization_context = 'meta_review'
            and target.platform = 'instagram'
            and account.authorization_context = 'meta_review'
          )
          or (
            target.authorization_context = 'owner'
            and account.authorization_context = 'owner'
            and (
              account.approval_state in ('approved', 'not_required')
              or (target.platform = 'tiktok' and target.metadata ->> 'privacyLevel' = 'SELF_ONLY')
              or (target.platform = 'youtube' and target.metadata ->> 'privacyStatus' = 'private')
            )
          )
        )
    );

  return query
  with due as (
    select candidate.id
    from public.post_targets candidate
    where candidate.authorization_context = 'owner' and (
        (candidate.status = 'scheduled' and candidate.scheduled_at_utc <= now())
        or (
          candidate.status = 'queued'
          and candidate.publish_request_sent_at is null
          and (
            candidate.lease_expires_at <= now()
            or (
              candidate.lease_expires_at is null
              and candidate.updated_at <= now() - interval '5 minutes'
            )
          )
        )
      )
      and (candidate.lease_expires_at is null or candidate.lease_expires_at <= now())
    order by candidate.scheduled_at_utc, candidate.id
    for update skip locked
    limit greatest(1, least(p_limit, 500))
  )
  update public.post_targets claimed
  set status = 'queued',
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(
        secs => greatest(30, least(p_lease_seconds, 900))
      ),
      updated_at = now()
  from due
  where claimed.id = due.id
  returning claimed.*;
end;
$$;

revoke all on function public.claim_due_targets(text, integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_due_targets(text, integer, integer)
to service_role;


create or replace function public.create_meta_review_post(
  p_reviewer_id uuid,
  p_title text,
  p_base_caption text,
  p_scheduled_at_utc timestamptz,
  p_media_ids uuid[],
  p_connected_account_id uuid,
  p_selected_media_ids uuid[],
  p_metadata jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_post_id uuid := gen_random_uuid();
  target_id uuid := gen_random_uuid();
  media_id uuid;
  review_generation uuid := app_private.current_review_generation(p_reviewer_id);
begin
  if review_generation is null then
    raise exception 'Meta reviewer authorization required' using errcode = '42501';
  end if;
  if char_length(p_title) not between 1 and 180
     or p_scheduled_at_utc < now() - interval '1 minute'
     or cardinality(p_media_ids) < 1
     or cardinality(p_selected_media_ids) < 1
     or p_metadata ->> 'contentType' not in (
       'feed_image', 'video', 'carousel', 'reel', 'story_image', 'story_video'
     )
  then
    raise exception 'Invalid Meta review post' using errcode = '22023';
  end if;
  if (
    select count(distinct id)
    from public.media_assets
    where id = any(p_media_ids)
      and owner_id = p_reviewer_id
      and authorization_context = 'meta_review'
      and authorization_generation = review_generation
      and storage_provider = 'uploadthing'
      and upload_status = 'complete'
      and deleted_at is null
  ) <> cardinality(p_media_ids) then
    raise exception 'Media does not belong to reviewer or upload is incomplete'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(p_selected_media_ids) selected_id
    where not (selected_id = any(p_media_ids))
  ) then
    raise exception 'Target media must be selected from post media'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.connected_accounts account
    where account.id = p_connected_account_id
      and account.owner_id = p_reviewer_id
      and account.platform = 'instagram'
      and account.authorization_context = 'meta_review'
      and account.authorization_generation = review_generation
      and account.connection_status = 'connected'
  ) then
    raise exception 'Instagram account does not belong to reviewer'
      using errcode = '42501';
  end if;

  insert into public.posts (
    id, owner_id, title, base_caption, scheduled_at_utc, authorization_context, authorization_generation
  ) values (
    created_post_id, p_reviewer_id, p_title, p_base_caption,
    p_scheduled_at_utc, 'meta_review', review_generation
  );
  foreach media_id in array p_media_ids loop
    insert into public.post_media (post_id, media_asset_id, sort_order)
    values (
      created_post_id, media_id, array_position(p_media_ids, media_id) - 1
    );
  end loop;
  insert into public.post_targets (
    id, owner_id, post_id, connected_account_id, platform, status,
    metadata, selected_media_ids, scheduled_at_utc, idempotency_key,
    authorization_context, authorization_generation
  ) values (
    target_id, p_reviewer_id, created_post_id, p_connected_account_id,
    'instagram', 'scheduled', p_metadata, p_selected_media_ids,
    p_scheduled_at_utc,
    'post:' || created_post_id || ':target:' || target_id || ':v1',
    'meta_review', review_generation
  );
  insert into public.audit_log (
    owner_id, actor_user_id, action, entity_type, entity_id, safe_metadata
  ) values (
    p_reviewer_id, p_reviewer_id, 'meta_review.post_scheduled', 'post',
    created_post_id::text, jsonb_build_object('target_count', 1)
  );
  return created_post_id;
end;
$$;


create or replace function public.consume_meta_review_rate_limit(
  p_reviewer_id uuid,
  p_route text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  window_time timestamptz;
  current_count integer;
begin
  if p_route !~ '^[a-z_]{1,64}$'
     or p_limit not between 1 and 1000
     or p_window_seconds not between 1 and 86400
     or app_private.current_review_generation(p_reviewer_id) is null
  then
    return false;
  end if;
  window_time := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  insert into public.rate_limit_buckets (
    owner_id, route, window_started_at, request_count
  ) values (
    p_reviewer_id, 'meta_review_' || p_route, window_time, 1
  )
  on conflict (owner_id, route, window_started_at)
  do update set request_count = public.rate_limit_buckets.request_count + 1
  returning request_count into current_count;
  return current_count <= p_limit;
end;
$$;


create or replace function public.complete_uploadthing_media(
  p_media_id uuid,
  p_owner_id uuid,
  p_provider_file_key text,
  p_provider_url text,
  p_size_bytes bigint,
  p_mime_type text,
  p_checksum_sha256 text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  media public.media_assets%rowtype;
begin
  if p_provider_file_key is null
    or char_length(p_provider_file_key) not between 1 and 512
    or p_provider_url !~ '^https://'
  then
    return 'invalid';
  end if;

  select * into media
  from public.media_assets
  where id = p_media_id and owner_id = p_owner_id
  for update;
  if not found then
    return 'not_found';
  end if;
  if media.authorization_context = 'meta_review' and (media.authorization_generation is null
    or media.authorization_generation is distinct from app_private.current_review_generation(p_owner_id)) then
    return 'unavailable';
  end if;
  if media.storage_provider <> 'uploadthing' then
    return 'conflict';
  end if;
  if media.upload_status = 'complete' then
    if media.provider_file_key = p_provider_file_key
      and media.provider_url = p_provider_url
      and media.size_bytes = p_size_bytes
    then
      return 'already_complete';
    end if;
    return 'conflict';
  end if;
  if media.upload_status <> 'uploading' or media.deleted_at is not null then
    return 'unavailable';
  end if;
  if media.reservation_expires_at <= now() then
    return 'expired';
  end if;
  if media.size_bytes <> p_size_bytes or media.mime_type <> p_mime_type then
    update public.media_assets
    set deletion_blocked_reason = 'upload_metadata_mismatch',
        updated_at = now()
    where id = p_media_id;
    return 'mismatch';
  end if;

  update public.media_assets
  set object_key = p_provider_file_key,
      provider_file_key = p_provider_file_key,
      provider_url = p_provider_url,
      checksum_sha256 = nullif(p_checksum_sha256, ''),
      upload_status = 'complete',
      reservation_expires_at = null,
      upload_id = null,
      uploaded_parts = '[]'::jsonb,
      updated_at = now()
  where id = p_media_id;
  return 'completed';
end;
$$;

revoke all on function public.complete_uploadthing_media(uuid, uuid, text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.complete_uploadthing_media(uuid, uuid, text, text, bigint, text, text) to service_role;


create function public.claim_meta_review_targets(
  p_worker_id text, p_reviewer_id uuid, p_reviewer_email text, p_generation uuid,
  p_limit integer default 100, p_lease_seconds integer default 300
)
returns setof public.post_targets language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_generation is null or p_generation is distinct from app_private.current_review_generation(p_reviewer_id)
    or not exists (select 1 from public.meta_review_authorization r where r.reviewer_user_id = p_reviewer_id
      and r.reviewer_email = p_reviewer_email) then return; end if;
  return query with due as (
    select t.id from public.post_targets t
    where t.authorization_context = 'meta_review' and t.owner_id = p_reviewer_id
      and t.authorization_generation = p_generation and t.scheduled_at_utc <= now()
      and (t.status = 'scheduled' or (t.status = 'queued' and t.publish_request_sent_at is null
        and t.updated_at <= now() - interval '5 minutes'))
      and (t.lease_expires_at is null or t.lease_expires_at <= now())
      and app_private.publication_target_authorized(t, null, false, true, p_reviewer_id, p_reviewer_email)
    order by t.scheduled_at_utc, t.id for update skip locked
    limit greatest(0, least(p_limit, 100))
  ) update public.post_targets t set status = 'queued', lease_owner = p_worker_id,
    lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900))), updated_at = now()
  from due where t.id = due.id returning t.*;
end;
$$;
revoke all on function public.claim_meta_review_targets(text, uuid, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_meta_review_targets(text, uuid, text, uuid, integer, integer) to service_role;

create or replace function public.claim_stale_targets(
  p_worker_id text, p_limit integer default 100, p_stale_seconds integer default 900,
  p_lease_seconds integer default 300
)
returns setof public.post_targets language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query with stale as (
    select t.id from public.post_targets t
    where t.authorization_context = 'owner' and t.status in ('publishing', 'processing')
      and t.updated_at <= now() - make_interval(secs => greatest(300, least(p_stale_seconds, 86400)))
      and (t.lease_expires_at is null or t.lease_expires_at <= now())
    order by t.updated_at, t.id for update skip locked limit greatest(0, least(p_limit, 500))
  ) update public.post_targets t set lease_owner = p_worker_id,
    lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900))), updated_at = now()
  from stale where t.id = stale.id returning t.*;
end;
$$;
revoke all on function public.claim_stale_targets(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_stale_targets(text, integer, integer, integer) to service_role;

create function public.claim_stale_meta_review_targets(
  p_worker_id text, p_reviewer_id uuid, p_reviewer_email text, p_generation uuid,
  p_limit integer default 100, p_stale_seconds integer default 900, p_lease_seconds integer default 300
)
returns setof public.post_targets language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_generation is null or p_generation is distinct from app_private.current_review_generation(p_reviewer_id)
    or not exists (select 1 from public.meta_review_authorization r where r.reviewer_user_id = p_reviewer_id
      and r.reviewer_email = p_reviewer_email) then return; end if;
  return query with stale as (
    select t.id from public.post_targets t
    where t.authorization_context = 'meta_review' and t.owner_id = p_reviewer_id
      and t.authorization_generation = p_generation and t.status in ('publishing', 'processing')
      and t.updated_at <= now() - make_interval(secs => greatest(300, least(p_stale_seconds, 86400)))
      and (t.lease_expires_at is null or t.lease_expires_at <= now())
      and app_private.publication_target_authorized(t, null, false, true, p_reviewer_id, p_reviewer_email)
    order by t.updated_at, t.id for update skip locked limit greatest(0, least(p_limit, 100))
  ) update public.post_targets t set lease_owner = p_worker_id,
    lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900))), updated_at = now()
  from stale where t.id = stale.id returning t.*;
end;
$$;
revoke all on function public.claim_stale_meta_review_targets(text, uuid, text, uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_stale_meta_review_targets(text, uuid, text, uuid, integer, integer, integer) to service_role;

create function app_private.guard_review_object_generation()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.authorization_context = 'meta_review' and (new.authorization_generation is null
    or new.authorization_generation is distinct from app_private.current_review_generation(new.owner_id)) then
    raise exception 'Meta reviewer authorization required' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_review_object_generation() from public, anon, authenticated;
create trigger oauth_states_guard_generation before insert on public.oauth_states
for each row execute function app_private.guard_review_object_generation();
create trigger posts_guard_generation before insert on public.posts
for each row execute function app_private.guard_review_object_generation();
create trigger post_targets_guard_generation before insert on public.post_targets
for each row execute function app_private.guard_review_object_generation();
create trigger media_assets_guard_generation before insert on public.media_assets
for each row execute function app_private.guard_review_object_generation();
create trigger connected_accounts_guard_generation before insert or update of encrypted_access_token,
  encrypted_refresh_token, authorization_generation, authorization_context on public.connected_accounts
for each row when (new.connection_status = 'connected')
execute function app_private.guard_review_object_generation();

create function app_private.guard_review_analytics()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare a public.connected_accounts;
begin
  select * into a from public.connected_accounts where id = new.connected_account_id;
  if a.owner_id is distinct from new.owner_id or a.platform is distinct from new.platform then
    raise exception 'Account isolation required' using errcode = '42501';
  end if;
  if a.authorization_context = 'meta_review' and (a.authorization_generation is null
    or a.authorization_generation is distinct from app_private.current_review_generation(a.owner_id)
    or not exists (select 1 from public.post_targets t where t.id = new.post_target_id
      and t.owner_id = a.owner_id and t.authorization_generation = a.authorization_generation
      and t.connected_account_id = a.id and t.authorization_context = 'meta_review')) then
    raise exception 'Meta reviewer authorization required' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app_private.guard_review_analytics() from public, anon, authenticated;
create trigger analytics_snapshots_guard_generation before insert or update on public.analytics_snapshots
for each row execute function app_private.guard_review_analytics();

revoke all on function public.create_meta_review_post(uuid, text, text, timestamptz, uuid[], uuid, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.create_meta_review_post(uuid, text, text, timestamptz, uuid[], uuid, uuid[], jsonb) to service_role;
revoke all on function public.consume_meta_review_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_meta_review_rate_limit(uuid, text, integer, integer) to service_role;

create or replace function public.verify_meta_review_schema()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('ready', coalesce(
    to_regclass('public.meta_review_authorization') is not null
    and exists (select 1 from pg_class where oid = 'public.meta_review_authorization'::regclass and relrowsecurity)
    and (select count(*) = 3 from information_schema.columns where table_schema = 'public'
      and table_name in ('oauth_states', 'connected_accounts', 'post_targets') and column_name = 'authorization_context')
    and (select count(*) = 5 from information_schema.columns where table_schema = 'public'
      and table_name in ('oauth_states', 'connected_accounts', 'post_targets', 'posts', 'media_assets') and column_name = 'authorization_generation')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'post_targets' and column_name = 'row_version')
    and exists (select 1 from pg_index where indexrelid = to_regclass('public.connected_accounts_instagram_identity_unique') and indisunique and indisvalid)
    and (select count(*) = 3 from pg_trigger where tgname in (
      'postline_revoke_review_on_auth_update', 'postline_revoke_review_on_auth_delete', 'post_targets_advance_version') and tgenabled = 'O')
    and (select bool_and(to_regprocedure(signature) is not null
      and has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')
      and not has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')
      and not has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')) from (values
        ('public.current_meta_review_authorization(uuid,text)'),
        ('public.set_meta_review_authorization(uuid,text,boolean,timestamp with time zone)'),
        ('public.claim_publication_target(uuid,text,text,boolean,boolean,uuid,text,uuid)'),
        ('public.transition_publication_target(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)'),
        ('public.refresh_publication_credentials(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)'),
        ('public.consume_bound_oauth_state(text,text,public.social_platform,text,boolean,uuid,text,text)'),
        ('public.persist_bound_oauth_account(uuid,text,jsonb,text,boolean,uuid,text,text)'),
        ('public.create_meta_review_post(uuid,text,text,timestamp with time zone,uuid[],uuid,uuid[],jsonb)'),
        ('public.reserve_meta_review_media(uuid,text,text,bigint,integer,integer,numeric)'),
        ('public.consume_meta_review_rate_limit(uuid,text,integer,integer)'),
        ('public.meta_review_storage_usage(uuid)'),
        ('public.claim_meta_review_targets(text,uuid,text,uuid,integer,integer)'),
        ('public.claim_stale_meta_review_targets(text,uuid,text,uuid,integer,integer,integer)'),
        ('public.begin_account_disconnect(uuid,uuid)'),
        ('public.mark_account_disconnect_revocation_started(uuid,uuid,uuid)'),
        ('public.record_account_disconnect_revocation(uuid,uuid,uuid,text)'),
        ('public.complete_account_disconnect(uuid,uuid,uuid,boolean)')
      ) required(signature)), false))
$$;
revoke all on function public.verify_meta_review_schema() from public, anon, authenticated;
grant execute on function public.verify_meta_review_schema() to service_role;

commit;
