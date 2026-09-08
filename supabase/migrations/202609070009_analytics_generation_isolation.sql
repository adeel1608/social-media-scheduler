begin;

-- Reviewer analytics are authorization artifacts, not merely owner data. Keep
-- the exact authorization generation that produced each reviewer snapshot so
-- revocation and later reauthorization cannot revive an earlier review window.
alter table public.analytics_snapshots
  add column authorization_generation uuid;

-- The existing trigger cannot derive a durable generation. Remove it while the
-- table is locked by this transaction, then backfill only rows whose complete
-- account/target/post lineage proves one unambiguous originating generation.
drop trigger if exists analytics_snapshots_guard_generation
  on public.analytics_snapshots;

update public.analytics_snapshots snapshot
set authorization_generation = target.authorization_generation
from public.post_targets target
join public.connected_accounts account
  on account.id = target.connected_account_id
join public.posts post
  on post.id = target.post_id
where snapshot.post_target_id = target.id
  and snapshot.connected_account_id = account.id
  and snapshot.owner_id = target.owner_id
  and snapshot.owner_id = account.owner_id
  and snapshot.owner_id = post.owner_id
  and snapshot.platform = 'instagram'
  and target.platform = 'instagram'
  and account.platform = 'instagram'
  and target.authorization_context = 'meta_review'
  and account.authorization_context = 'meta_review'
  and post.authorization_context = 'meta_review'
  and target.authorization_generation is not null
  and account.authorization_generation = target.authorization_generation
  and post.authorization_generation = target.authorization_generation;

create index analytics_snapshots_review_generation_idx
on public.analytics_snapshots (
  owner_id,
  authorization_generation,
  platform,
  captured_at desc,
  id desc
)
where authorization_generation is not null;

create or replace function app_private.guard_review_analytics()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  account_owner uuid;
  account_platform public.social_platform;
  account_context text;
  account_generation uuid;
  target_owner uuid;
  target_post uuid;
  target_account uuid;
  target_platform public.social_platform;
  target_context text;
  target_generation uuid;
  post_owner uuid;
  post_context text;
  post_generation uuid;
begin
  select
    account.owner_id,
    account.platform,
    account.authorization_context,
    account.authorization_generation
  into
    account_owner,
    account_platform,
    account_context,
    account_generation
  from public.connected_accounts account
  where account.id = new.connected_account_id;

  if not found
     or account_owner is distinct from new.owner_id
     or account_platform is distinct from new.platform
  then
    raise exception 'Account isolation required' using errcode = '42501';
  end if;

  if new.post_target_id is not null then
    select
      target.owner_id,
      target.post_id,
      target.connected_account_id,
      target.platform,
      target.authorization_context,
      target.authorization_generation,
      post.owner_id,
      post.authorization_context,
      post.authorization_generation
    into
      target_owner,
      target_post,
      target_account,
      target_platform,
      target_context,
      target_generation,
      post_owner,
      post_context,
      post_generation
    from public.post_targets target
    join public.posts post on post.id = target.post_id
    where target.id = new.post_target_id;

    if not found
       or target_owner is distinct from new.owner_id
       or post_owner is distinct from new.owner_id
       or target_account is distinct from new.connected_account_id
       or target_platform is distinct from new.platform
    then
      raise exception 'Analytics target isolation required'
        using errcode = '42501';
    end if;
  end if;

  if account_context = 'meta_review' then
    if new.post_target_id is null
       or new.platform <> 'instagram'
       or target_context is distinct from 'meta_review'
       or post_context is distinct from 'meta_review'
       or account_generation is null
       or target_generation is distinct from account_generation
       or post_generation is distinct from account_generation
       or account_generation is distinct from
          app_private.current_review_generation(new.owner_id)
    then
      raise exception 'Meta reviewer authorization required'
        using errcode = '42501';
    end if;
    -- Never trust a caller-supplied generation. The durable value comes from
    -- the mutually consistent, currently authorized database relations.
    new.authorization_generation := target_generation;
  elsif account_context = 'owner' then
    if new.post_target_id is not null
       and (
         target_context is distinct from 'owner'
         or post_context is distinct from 'owner'
       )
    then
      raise exception 'Owner analytics isolation required'
        using errcode = '42501';
    end if;
    new.authorization_generation := null;
  else
    raise exception 'Analytics authorization context required'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

alter function app_private.guard_review_analytics() owner to postgres;
revoke all on function app_private.guard_review_analytics()
  from public, anon, authenticated, service_role;

create trigger analytics_snapshots_guard_generation
before insert or update on public.analytics_snapshots
for each row execute function app_private.guard_review_analytics();

-- This is the only service-role reviewer read path. It rechecks the active
-- generation inside the database and joins every disclosed field through the
-- same owner, context, platform, account and generation boundary.
create function public.list_meta_review_analytics(
  p_reviewer_id uuid,
  p_generation uuid,
  p_target_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 500
)
returns table (
  id uuid,
  post_target_id uuid,
  platform public.social_platform,
  captured_at timestamptz,
  period_start date,
  period_end date,
  normalized_metrics jsonb,
  raw_metrics jsonb,
  unavailable_metrics text[],
  post_targets jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    snapshot.id,
    snapshot.post_target_id,
    snapshot.platform,
    snapshot.captured_at,
    snapshot.period_start,
    snapshot.period_end,
    snapshot.normalized_metrics,
    snapshot.raw_metrics,
    snapshot.unavailable_metrics,
    jsonb_build_object(
      'metadata', target.metadata,
      'remote_url', target.remote_url,
      'posts', jsonb_build_object('title', post.title)
    )
  from public.analytics_snapshots snapshot
  join public.post_targets target
    on target.id = snapshot.post_target_id
  join public.connected_accounts account
    on account.id = snapshot.connected_account_id
  join public.posts post
    on post.id = target.post_id
  where p_reviewer_id is not null
    and p_generation is not null
    and p_generation = app_private.current_review_generation(p_reviewer_id)
    and snapshot.owner_id = p_reviewer_id
    and snapshot.authorization_generation = p_generation
    and snapshot.platform = 'instagram'
    and target.owner_id = p_reviewer_id
    and target.connected_account_id = account.id
    and target.platform = 'instagram'
    and target.authorization_context = 'meta_review'
    and target.authorization_generation = p_generation
    and account.owner_id = p_reviewer_id
    and account.platform = 'instagram'
    and account.authorization_context = 'meta_review'
    and account.authorization_generation = p_generation
    and post.owner_id = p_reviewer_id
    and post.authorization_context = 'meta_review'
    and post.authorization_generation = p_generation
    and (p_target_id is null or snapshot.post_target_id = p_target_id)
    and (p_from is null or snapshot.captured_at >= p_from)
    and (p_to is null or snapshot.captured_at <= p_to)
  order by snapshot.captured_at desc, snapshot.id desc
  limit greatest(0, least(coalesce(p_limit, 0), 500))
$$;

alter function public.list_meta_review_analytics(
  uuid, uuid, uuid, timestamptz, timestamptz, integer
) owner to postgres;
revoke all on function public.list_meta_review_analytics(
  uuid, uuid, uuid, timestamptz, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.list_meta_review_analytics(
  uuid, uuid, uuid, timestamptz, timestamptz, integer
) to service_role;

-- Block the old Worker from bypassing the generation-aware RPC after the
-- migration lands. New writes use return=minimal and retain INSERT privilege.
revoke select on table public.analytics_snapshots from service_role;
grant insert on table public.analytics_snapshots to service_role;

-- Preserve the preflight contract while extending it into a rollout barrier:
-- a new Worker cannot be deployed against an older analytics schema.
create or replace function public.verify_meta_review_schema()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('ready', coalesce(
    to_regclass('public.meta_review_authorization') is not null
    and exists (
      select 1
      from pg_class
      where oid = 'public.meta_review_authorization'::regclass
        and relrowsecurity
    )
    and (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('oauth_states', 'connected_accounts', 'post_targets')
        and column_name = 'authorization_context'
    )
    and (
      select count(*) = 5
      from information_schema.columns
      where table_schema = 'public'
        and table_name in (
          'oauth_states',
          'connected_accounts',
          'post_targets',
          'posts',
          'media_assets'
        )
        and column_name = 'authorization_generation'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'analytics_snapshots'
        and column_name = 'authorization_generation'
        and data_type = 'uuid'
        and is_nullable = 'YES'
    )
    and (
      select count(*) = 6
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'oauth_states'
        and column_name in (
          'callback_received_at',
          'completion_consumed_at',
          'pending_authorization_code',
          'pending_authorization_code_nonce',
          'pending_authorization_code_key_version',
          'pending_completion_handle_hash'
        )
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'post_targets'
        and column_name = 'row_version'
    )
    and exists (
      select 1
      from pg_index
      where indexrelid = to_regclass(
        'public.connected_accounts_instagram_identity_unique'
      )
        and indisunique
        and indisvalid
    )
    and exists (
      select 1
      from pg_index
      where indexrelid = to_regclass(
        'public.oauth_states_pending_completion_handle_idx'
      )
        and indisunique
        and indisvalid
    )
    and exists (
      select 1
      from pg_index
      where indexrelid = to_regclass(
        'public.analytics_snapshots_review_generation_idx'
      )
        and indisvalid
    )
    and (
      select count(*) = 4
      from pg_trigger
      where tgname in (
        'postline_revoke_review_on_auth_update',
        'postline_revoke_review_on_auth_delete',
        'post_targets_advance_version',
        'analytics_snapshots_guard_generation'
      )
        and tgenabled = 'O'
    )
    and exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'media_assets'
        and policyname = 'media_assets_owner_select'
        and cmd = 'SELECT'
    )
    and not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = 'media_assets'
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    )
    and has_table_privilege('authenticated', 'public.media_assets', 'SELECT')
    and not has_table_privilege('authenticated', 'public.media_assets', 'INSERT')
    and not has_table_privilege('authenticated', 'public.media_assets', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.media_assets', 'DELETE')
    and not has_table_privilege('anon', 'public.media_assets', 'INSERT')
    and not has_table_privilege('anon', 'public.media_assets', 'UPDATE')
    and not has_table_privilege('anon', 'public.media_assets', 'DELETE')
    and has_table_privilege(
      'service_role', 'public.analytics_snapshots', 'INSERT'
    )
    and not has_table_privilege(
      'service_role', 'public.analytics_snapshots', 'SELECT'
    )
    and not has_function_privilege(
      'service_role',
      'public.consume_bound_oauth_state(text,text,public.social_platform,text,boolean,uuid,text,text)',
      'EXECUTE'
    )
    and exists (
      select 1
      from pg_proc
      where oid = to_regprocedure(
        'public.list_meta_review_analytics(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer)'
      )
        and provolatile = 's'
        and prosecdef
        and proowner = (select oid from pg_roles where rolname = 'postgres')
        and proconfig @> array['search_path=public, pg_temp']
    )
    and (
      select bool_and(
        to_regprocedure(signature) is not null
        and has_function_privilege(
          'service_role',
          to_regprocedure(signature),
          'EXECUTE'
        )
        and not has_function_privilege(
          'anon',
          to_regprocedure(signature),
          'EXECUTE'
        )
        and not has_function_privilege(
          'authenticated',
          to_regprocedure(signature),
          'EXECUTE'
        )
      )
      from (values
        ('public.current_meta_review_authorization(uuid,text)'),
        ('public.set_meta_review_authorization(uuid,text,boolean,timestamp with time zone)'),
        ('public.claim_publication_target(uuid,text,text,boolean,boolean,uuid,text,uuid)'),
        ('public.transition_publication_target(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)'),
        ('public.refresh_publication_credentials(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)'),
        ('public.record_bound_oauth_callback(text,text,public.social_platform,text,text,text,text,text,boolean,uuid,text,text)'),
        ('public.consume_oauth_completion(text,text,public.social_platform,uuid,text,uuid,text,boolean,uuid,text,text)'),
        ('public.cancel_pending_oauth(uuid,uuid)'),
        ('public.expire_pending_oauth_states(integer)'),
        ('public.persist_bound_oauth_account(uuid,text,jsonb,text,boolean,uuid,text,text)'),
        ('public.create_meta_review_post(uuid,text,text,timestamp with time zone,uuid[],uuid,uuid[],jsonb)'),
        ('public.reserve_meta_review_media(uuid,text,text,bigint,integer,integer,numeric)'),
        ('public.complete_uploadthing_media(uuid,uuid,text,text,bigint,text,text)'),
        ('public.consume_meta_review_rate_limit(uuid,text,integer,integer)'),
        ('public.meta_review_storage_usage(uuid)'),
        ('public.claim_meta_review_targets(text,uuid,text,uuid,integer,integer)'),
        ('public.claim_stale_meta_review_targets(text,uuid,text,uuid,integer,integer,integer)'),
        ('public.begin_account_disconnect(uuid,uuid)'),
        ('public.mark_account_disconnect_revocation_started(uuid,uuid,uuid)'),
        ('public.record_account_disconnect_revocation(uuid,uuid,uuid,text)'),
        ('public.complete_account_disconnect(uuid,uuid,uuid,boolean)'),
        ('public.list_meta_review_analytics(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer)')
      ) required(signature)
    )
  , false))
$$;

alter function public.verify_meta_review_schema() owner to postgres;
revoke all on function public.verify_meta_review_schema()
  from public, anon, authenticated;
grant execute on function public.verify_meta_review_schema()
  to service_role;

commit;
