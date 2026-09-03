begin;

create extension if not exists pgcrypto;

create type public.social_platform as enum ('instagram', 'tiktok', 'youtube');
create type public.target_status as enum (
  'draft',
  'scheduled',
  'blocked_authorization',
  'queued',
  'publishing',
  'processing',
  'published',
  'failed',
  'needs_review',
  'cancelled'
);
create type public.connection_status as enum ('connected', 'expired', 'revoked', 'error', 'disconnected');
create type public.approval_state as enum ('approved', 'pending', 'not_required', 'rejected');

create table public.installation_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  owner_email text not null unique check (owner_email = lower(owner_email)),
  timezone text not null default 'Australia/Melbourne' check (timezone = 'Australia/Melbourne'),
  configured_services jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  platform public.social_platform not null,
  remote_account_id text not null,
  username text,
  encrypted_access_token text not null,
  access_token_nonce text not null,
  encrypted_refresh_token text,
  refresh_token_nonce text,
  encryption_key_version text not null default 'v1',
  scopes text[] not null default '{}',
  token_expires_at timestamptz,
  connection_status public.connection_status not null default 'connected',
  approval_state public.approval_state not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, platform, remote_account_id),
  check ((encrypted_refresh_token is null) = (refresh_token_nonce is null))
);

create table public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  platform public.social_platform not null,
  state_hash text not null unique,
  encrypted_pkce_verifier text,
  pkce_nonce text,
  encryption_key_version text not null default 'v1',
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '15 minutes')
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_key text not null unique,
  original_filename text not null,
  mime_type text not null check (mime_type ~ '^(image|video)/'),
  size_bytes bigint not null check (size_bytes > 0),
  width integer check (width > 0),
  height integer check (height > 0),
  duration_seconds numeric check (duration_seconds > 0),
  checksum_sha256 text,
  upload_status text not null default 'pending' check (upload_status in ('pending', 'uploading', 'complete', 'aborted', 'deleted')),
  upload_id text,
  uploaded_parts jsonb not null default '[]'::jsonb,
  retain_until timestamptz,
  deletion_blocked_reason text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  base_caption text not null default '',
  timezone text not null default 'Australia/Melbourne' check (timezone = 'Australia/Melbourne'),
  scheduled_at_utc timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.post_media (
  post_id uuid not null references public.posts(id) on delete cascade,
  media_asset_id uuid not null references public.media_assets(id) on delete restrict,
  sort_order integer not null check (sort_order >= 0),
  primary key (post_id, media_asset_id),
  unique (post_id, sort_order)
);

create table public.post_targets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  platform public.social_platform not null,
  status public.target_status not null default 'draft',
  metadata jsonb not null default '{}'::jsonb,
  selected_media_ids uuid[] not null default '{}',
  scheduled_at_utc timestamptz not null,
  idempotency_key text not null unique,
  lease_owner text,
  lease_expires_at timestamptz,
  publish_request_sent_at timestamptz,
  platform_upload_state jsonb,
  remote_content_id text,
  remote_url text,
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, platform)
);

create table public.publish_attempts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  post_target_id uuid not null references public.post_targets(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  idempotency_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('processing', 'published', 'failed', 'ambiguous')),
  request_sent_at timestamptz,
  safe_error_code text,
  safe_error_message text,
  sanitized_response jsonb not null default '{}'::jsonb,
  manual_retry boolean not null default false,
  unique (post_target_id, attempt_number),
  unique (idempotency_key)
);

create table public.analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  post_target_id uuid references public.post_targets(id) on delete cascade,
  connected_account_id uuid not null references public.connected_accounts(id) on delete cascade,
  platform public.social_platform not null,
  captured_at timestamptz not null default now(),
  period_start date,
  period_end date,
  normalized_metrics jsonb not null default '{}'::jsonb,
  raw_metrics jsonb not null default '{}'::jsonb,
  unavailable_metrics text[] not null default '{}'
);

create table public.email_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  post_target_id uuid references public.post_targets(id) on delete cascade,
  event_type text not null check (event_type in ('target_failed', 'target_needs_review')),
  deduplication_key text not null unique,
  provider_message_id text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  safe_error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  request_id text,
  ip_hash text,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.rate_limit_buckets (
  owner_id uuid not null references auth.users(id) on delete cascade,
  route text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (owner_id, route, window_started_at)
);

create index connected_accounts_owner_platform_idx on public.connected_accounts (owner_id, platform, connection_status);
create index connected_accounts_expiry_idx on public.connected_accounts (token_expires_at) where connection_status = 'connected';
create index oauth_states_owner_expiry_idx on public.oauth_states (owner_id, expires_at) where consumed_at is null;
create index media_assets_owner_status_idx on public.media_assets (owner_id, upload_status, created_at desc);
create index media_assets_cleanup_idx on public.media_assets (retain_until) where deleted_at is null;
create index posts_owner_schedule_idx on public.posts (owner_id, scheduled_at_utc desc, id);
create index post_targets_due_idx on public.post_targets (scheduled_at_utc, id) where status in ('scheduled', 'blocked_authorization');
create index post_targets_owner_status_idx on public.post_targets (owner_id, status, scheduled_at_utc desc, id);
create index post_targets_platform_status_idx on public.post_targets (platform, status, scheduled_at_utc);
create index post_targets_remote_idx on public.post_targets (platform, remote_content_id) where remote_content_id is not null;
create index publish_attempts_target_idx on public.publish_attempts (post_target_id, started_at desc);
create index analytics_snapshots_target_date_idx on public.analytics_snapshots (post_target_id, captured_at desc);
create index analytics_snapshots_owner_filters_idx on public.analytics_snapshots (owner_id, platform, captured_at desc);
create index email_events_target_idx on public.email_events (post_target_id, event_type);
create index audit_log_owner_date_idx on public.audit_log (owner_id, created_at desc);

create schema if not exists app_private;

create or replace function app_private.is_owner(candidate_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select auth.uid() = candidate_owner
    and exists (
      select 1 from public.installation_settings s
      where s.owner_id = candidate_owner
        and lower(s.owner_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;

revoke all on function app_private.is_owner(uuid) from public;
grant execute on function app_private.is_owner(uuid) to authenticated;

alter table public.installation_settings enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.oauth_states enable row level security;
alter table public.media_assets enable row level security;
alter table public.posts enable row level security;
alter table public.post_media enable row level security;
alter table public.post_targets enable row level security;
alter table public.publish_attempts enable row level security;
alter table public.analytics_snapshots enable row level security;
alter table public.email_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.rate_limit_buckets enable row level security;

create policy installation_owner_select on public.installation_settings for select to authenticated using (app_private.is_owner(owner_id));
create policy installation_owner_update on public.installation_settings for update to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));

create policy connected_accounts_owner_all on public.connected_accounts for all to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));
create policy oauth_states_owner_all on public.oauth_states for all to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));
create policy media_assets_owner_all on public.media_assets for all to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));
create policy posts_owner_all on public.posts for all to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));
create policy post_targets_owner_all on public.post_targets for all to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));
create policy publish_attempts_owner_select on public.publish_attempts for select to authenticated using (app_private.is_owner(owner_id));
create policy analytics_owner_all on public.analytics_snapshots for all to authenticated using (app_private.is_owner(owner_id)) with check (app_private.is_owner(owner_id));
create policy email_events_owner_select on public.email_events for select to authenticated using (app_private.is_owner(owner_id));
create policy audit_log_owner_select on public.audit_log for select to authenticated using (app_private.is_owner(owner_id));
create policy rate_limits_owner_select on public.rate_limit_buckets for select to authenticated using (app_private.is_owner(owner_id));
create policy post_media_owner_all on public.post_media for all to authenticated
using (exists (select 1 from public.posts p where p.id = post_id and app_private.is_owner(p.owner_id)))
with check (exists (select 1 from public.posts p where p.id = post_id and app_private.is_owner(p.owner_id)));

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
  if current_setting('request.jwt.claim.role', true) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  update public.post_targets target
  set status = 'blocked_authorization', updated_at = now()
  where target.status = 'scheduled'
    and target.scheduled_at_utc <= now()
    and not exists (
      select 1 from public.connected_accounts account
      where account.id = target.connected_account_id
        and account.connection_status = 'connected'
        and (
          account.token_expires_at is null
          or account.token_expires_at > now() + interval '60 seconds'
          or account.encrypted_refresh_token is not null
          or account.platform = 'instagram'
        )
        and (
          account.approval_state in ('approved', 'not_required')
          or (target.platform = 'tiktok' and target.metadata ->> 'privacyLevel' = 'SELF_ONLY')
          or (target.platform = 'youtube' and target.metadata ->> 'privacyStatus' = 'private')
        )
    );

  update public.post_targets target
  set status = 'scheduled', updated_at = now()
  where target.status = 'blocked_authorization'
    and target.scheduled_at_utc <= now()
    and exists (
      select 1 from public.connected_accounts account
      where account.id = target.connected_account_id
        and account.connection_status = 'connected'
        and (
          account.token_expires_at is null
          or account.token_expires_at > now() + interval '60 seconds'
          or account.encrypted_refresh_token is not null
          or account.platform = 'instagram'
        )
        and (
          account.approval_state in ('approved', 'not_required')
          or (target.platform = 'tiktok' and target.metadata ->> 'privacyLevel' = 'SELF_ONLY')
          or (target.platform = 'youtube' and target.metadata ->> 'privacyStatus' = 'private')
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
      lease_expires_at = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900))),
      updated_at = now()
  from due
  where claimed.id = due.id
  returning claimed.*;
end;
$$;

revoke all on function public.claim_due_targets(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_due_targets(text, integer, integer) to service_role;

create or replace function public.begin_manual_retry(p_target_id uuid)
returns public.post_targets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result public.post_targets;
begin
  update public.post_targets
  set status = 'scheduled',
      scheduled_at_utc = greatest(now(), scheduled_at_utc),
      lease_owner = null,
      lease_expires_at = null,
      last_error_code = null,
      last_error_message = null,
      publish_request_sent_at = null,
      platform_upload_state = null,
      remote_content_id = null,
      remote_url = null,
      idempotency_key = 'post:' || post_id || ':target:' || id || ':v' ||
        (select coalesce(max(attempt_number), 0) + 1 from public.publish_attempts where post_target_id = p_target_id),
      updated_at = now()
  where id = p_target_id
    and status = 'failed'
    and app_private.is_owner(owner_id)
  returning * into result;

  if result.id is null then
    raise exception 'Target is not retryable' using errcode = 'P0001';
  end if;
  return result;
end;
$$;

revoke all on function public.begin_manual_retry(uuid) from public, anon;
grant execute on function public.begin_manual_retry(uuid) to authenticated;

commit;
