begin;

-- Browser clients may inspect only media belonging to the installation owner.
-- All mutations are performed by the quota RPCs or by fixed Worker service
-- operations after provider cleanup has been authoritatively confirmed.
drop policy if exists media_assets_owner_all on public.media_assets;
drop policy if exists media_assets_owner_select on public.media_assets;
create policy media_assets_owner_select
on public.media_assets
for select
to authenticated
using (app_private.is_owner(owner_id));

revoke insert, update, delete, truncate, references, trigger
  on table public.media_assets
  from public, anon, authenticated;
grant select on table public.media_assets to authenticated;
grant select, insert, update, delete on table public.media_assets to service_role;

-- Make every media mutation boundary and its privilege contract explicit.
alter function app_private.reserve_workspace_media(
  uuid, text, text, text, bigint, integer, integer, numeric
) owner to postgres;
revoke all on function app_private.reserve_workspace_media(
  uuid, text, text, text, bigint, integer, integer, numeric
) from public, anon, authenticated, service_role;

alter function public.reserve_uploadthing_media(
  text, text, bigint, integer, integer, numeric
) owner to postgres;
revoke all on function public.reserve_uploadthing_media(
  text, text, bigint, integer, integer, numeric
) from public, anon, authenticated;
grant execute on function public.reserve_uploadthing_media(
  text, text, bigint, integer, integer, numeric
) to authenticated;

alter function public.reserve_meta_review_media(
  uuid, text, text, bigint, integer, integer, numeric
) owner to postgres;
revoke all on function public.reserve_meta_review_media(
  uuid, text, text, bigint, integer, integer, numeric
) from public, anon, authenticated;
grant execute on function public.reserve_meta_review_media(
  uuid, text, text, bigint, integer, integer, numeric
) to service_role;

alter function public.complete_uploadthing_media(
  uuid, uuid, text, text, bigint, text, text
) owner to postgres;
revoke all on function public.complete_uploadthing_media(
  uuid, uuid, text, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.complete_uploadthing_media(
  uuid, uuid, text, text, bigint, text, text
) to service_role;

alter function public.uploadthing_storage_usage() owner to postgres;
revoke all on function public.uploadthing_storage_usage()
  from public, anon;
grant execute on function public.uploadthing_storage_usage()
  to authenticated;

alter function public.meta_review_storage_usage(uuid) owner to postgres;
revoke all on function public.meta_review_storage_usage(uuid)
  from public, anon, authenticated;
grant execute on function public.meta_review_storage_usage(uuid)
  to service_role;

-- This stable, non-mutating preflight is the deployment ordering barrier. A
-- new Worker cannot deploy against an old/partial OAuth or media schema.
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
    and (
      select count(*) = 3
      from pg_trigger
      where tgname in (
        'postline_revoke_review_on_auth_update',
        'postline_revoke_review_on_auth_delete',
        'post_targets_advance_version'
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
    and not has_function_privilege(
      'service_role',
      'public.consume_bound_oauth_state(text,text,public.social_platform,text,boolean,uuid,text,text)',
      'EXECUTE'
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
        ('public.complete_account_disconnect(uuid,uuid,uuid,boolean)')
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
