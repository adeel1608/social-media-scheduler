begin;

alter table public.oauth_states
  add column if not exists authorization_context text not null default 'owner';
alter table public.connected_accounts
  add column if not exists authorization_context text not null default 'owner';
alter table public.post_targets
  add column if not exists authorization_context text not null default 'owner';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'oauth_states_authorization_context_check'
      and conrelid = 'public.oauth_states'::regclass
  ) then
    alter table public.oauth_states
      add constraint oauth_states_authorization_context_check
      check (authorization_context in ('owner', 'meta_review'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'connected_accounts_authorization_context_check'
      and conrelid = 'public.connected_accounts'::regclass
  ) then
    alter table public.connected_accounts
      add constraint connected_accounts_authorization_context_check
      check (authorization_context in ('owner', 'meta_review'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'post_targets_authorization_context_check'
      and conrelid = 'public.post_targets'::regclass
  ) then
    alter table public.post_targets
      add constraint post_targets_authorization_context_check
      check (authorization_context in ('owner', 'meta_review'));
  end if;
end;
$$;

create index if not exists connected_accounts_meta_review_owner_idx
on public.connected_accounts (owner_id, platform, connection_status)
where authorization_context = 'meta_review';

create index if not exists post_targets_meta_review_owner_status_idx
on public.post_targets (owner_id, status, scheduled_at_utc)
where authorization_context = 'meta_review';

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
     or not exists (select 1 from auth.users where id = p_reviewer_id)
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

create or replace function public.reserve_meta_review_media(
  p_reviewer_id uuid,
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint,
  p_width integer default null,
  p_height integer default null,
  p_duration_seconds numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  created_media_id uuid := gen_random_uuid();
  used_bytes bigint;
  active_media_limit constant bigint := 1932735283;
begin
  if not exists (select 1 from auth.users where id = p_reviewer_id)
     or p_size_bytes <= 0
     or p_original_filename is null
     or char_length(p_original_filename) not between 1 and 255
     or not (
       p_mime_type ~ '^(image|video)/'
       or p_mime_type = 'application/octet-stream'
     )
  then
    raise exception 'Invalid Meta review media reservation'
      using errcode = '22023';
  end if;
  if p_size_bytes > active_media_limit then
    raise exception 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: file exceeds 1.8 GiB'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_reviewer_id::text, 0));
  select coalesce(sum(size_bytes), 0)
  into used_bytes
  from public.media_assets
  where owner_id = p_reviewer_id
    and storage_provider = 'uploadthing'
    and deleted_at is null
    and upload_status in ('uploading', 'complete');
  if used_bytes + p_size_bytes > active_media_limit then
    raise exception 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: active and reserved media exceed 1.8 GiB'
      using errcode = 'P0001';
  end if;

  insert into public.media_assets (
    id, owner_id, object_key, original_filename, mime_type, size_bytes,
    width, height, duration_seconds, upload_status, storage_provider,
    reservation_expires_at
  ) values (
    created_media_id, p_reviewer_id,
    'reservation:' || created_media_id::text,
    p_original_filename, p_mime_type, p_size_bytes,
    p_width, p_height, p_duration_seconds, 'uploading', 'uploadthing',
    now() + interval '24 hours'
  );
  return created_media_id;
end;
$$;

create or replace function public.meta_review_storage_usage(
  p_reviewer_id uuid
)
returns table(active_bytes bigint, reserved_bytes bigint, limit_bytes bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(sum(size_bytes), 0)::bigint,
    coalesce(sum(size_bytes) filter (where upload_status = 'uploading'), 0)::bigint,
    1932735283::bigint
  from public.media_assets
  where owner_id = p_reviewer_id
    and storage_provider = 'uploadthing'
    and deleted_at is null
    and upload_status in ('uploading', 'complete');
$$;

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
begin
  if not exists (select 1 from auth.users where id = p_reviewer_id) then
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
      and account.connection_status = 'connected'
  ) then
    raise exception 'Instagram account does not belong to reviewer'
      using errcode = '42501';
  end if;

  insert into public.posts (
    id, owner_id, title, base_caption, scheduled_at_utc
  ) values (
    created_post_id, p_reviewer_id, p_title, p_base_caption,
    p_scheduled_at_utc
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
    authorization_context
  ) values (
    target_id, p_reviewer_id, created_post_id, p_connected_account_id,
    'instagram', 'scheduled', p_metadata, p_selected_media_ids,
    p_scheduled_at_utc,
    'post:' || created_post_id || ':target:' || target_id || ':v1',
    'meta_review'
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

revoke all on function public.consume_meta_review_rate_limit(uuid, text, integer, integer)
from public, anon, authenticated;
revoke all on function public.reserve_meta_review_media(uuid, text, text, bigint, integer, integer, numeric)
from public, anon, authenticated;
revoke all on function public.meta_review_storage_usage(uuid)
from public, anon, authenticated;
revoke all on function public.create_meta_review_post(uuid, text, text, timestamptz, uuid[], uuid, uuid[], jsonb)
from public, anon, authenticated;
grant execute on function public.consume_meta_review_rate_limit(uuid, text, integer, integer)
to service_role;
grant execute on function public.reserve_meta_review_media(uuid, text, text, bigint, integer, integer, numeric)
to service_role;
grant execute on function public.meta_review_storage_usage(uuid)
to service_role;
grant execute on function public.create_meta_review_post(uuid, text, text, timestamptz, uuid[], uuid, uuid[], jsonb)
to service_role;

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
  where target.status = 'scheduled'
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
  where target.status = 'blocked_authorization'
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
    where (
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

create or replace function app_private.enqueue_target_failure_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  attempt_number integer;
begin
  if new.authorization_context = 'meta_review'
     or new.status not in ('failed', 'needs_review')
     or new.status is not distinct from old.status then
    return new;
  end if;
  select coalesce(max(candidate.attempt_number), 1)
  into attempt_number
  from public.publish_attempts candidate
  where candidate.post_target_id = new.id;
  insert into public.email_events (
    owner_id, post_target_id, event_type, deduplication_key
  ) values (
    new.owner_id, new.id,
    case when new.status = 'needs_review'
      then 'target_needs_review' else 'target_failed' end,
    'failure:' || new.id::text || ':attempt:' || attempt_number::text
  ) on conflict (deduplication_key) do nothing;
  return new;
end;
$$;

revoke all on function app_private.enqueue_target_failure_email()
from public, anon, authenticated;

create or replace function public.verify_meta_review_schema()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ready',
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'post_targets'
        and column_name = 'authorization_context'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'connected_accounts'
        and column_name = 'authorization_context'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'oauth_states'
        and column_name = 'authorization_context'
    )
    and to_regprocedure('public.consume_meta_review_rate_limit(uuid,text,integer,integer)') is not null
    and to_regprocedure('public.reserve_meta_review_media(uuid,text,text,bigint,integer,integer,numeric)') is not null
    and to_regprocedure('public.meta_review_storage_usage(uuid)') is not null
    and to_regprocedure('public.create_meta_review_post(uuid,text,text,timestamp with time zone,uuid[],uuid,uuid[],jsonb)') is not null
  );
$$;

revoke all on function public.verify_meta_review_schema()
from public, anon, authenticated;
grant execute on function public.verify_meta_review_schema()
to service_role;

commit;
