begin;

create or replace function public.create_scheduled_post(
  p_title text,
  p_base_caption text,
  p_scheduled_at_utc timestamptz,
  p_media_ids uuid[],
  p_targets jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  created_post_id uuid := gen_random_uuid();
  target jsonb;
  target_id uuid;
  media_id uuid;
  account_id uuid;
  selected_media_ids uuid[];
  owner uuid := auth.uid();
  owner_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  target_count integer := jsonb_array_length(p_targets);
begin
  if owner is null or not app_private.is_owner(owner) then
    raise exception 'Owner authorization required' using errcode = '42501';
  end if;
  if char_length(p_title) not between 1 and 180 then
    raise exception 'Invalid post title' using errcode = '22023';
  end if;
  if p_scheduled_at_utc < now() - interval '1 minute' then
    raise exception 'Scheduled time is too far in the past' using errcode = '22023';
  end if;
  if cardinality(p_media_ids) < 1 or target_count not between 1 and 3 then
    raise exception 'Media and one to three targets are required' using errcode = '22023';
  end if;
  if (select count(*) from public.media_assets where id = any(p_media_ids) and owner_id = owner and upload_status = 'complete') <> cardinality(p_media_ids) then
    raise exception 'Media does not belong to owner or upload is incomplete' using errcode = '42501';
  end if;

  insert into public.posts (id, owner_id, title, base_caption, scheduled_at_utc)
  values (created_post_id, owner, p_title, p_base_caption, p_scheduled_at_utc);

  foreach media_id in array p_media_ids loop
    insert into public.post_media (post_id, media_asset_id, sort_order)
    values (created_post_id, media_id, array_position(p_media_ids, media_id) - 1);
  end loop;

  for target in select * from jsonb_array_elements(p_targets) loop
    if target ->> 'platform' not in ('instagram', 'tiktok', 'youtube') then
      raise exception 'Unsupported target platform' using errcode = '22023';
    end if;
    account_id := nullif(target ->> 'connectedAccountId', '')::uuid;
    select coalesce(array_agg(value::uuid), p_media_ids)
    into selected_media_ids
    from jsonb_array_elements_text(target -> 'mediaIds');
    if selected_media_ids is null or cardinality(selected_media_ids) < 1 then
      selected_media_ids := p_media_ids;
    end if;
    if exists (
      select 1 from unnest(selected_media_ids) selected_id
      where not (selected_id = any(p_media_ids))
    ) then
      raise exception 'Target media must be selected from post media' using errcode = '22023';
    end if;
    if account_id is not null and not exists (
      select 1
      from public.connected_accounts account
      where account.id = account_id
        and account.owner_id = owner
        and account.platform = (target ->> 'platform')::public.social_platform
        and account.connection_status = 'connected'
    ) then
      raise exception 'Connected account does not belong to owner or platform' using errcode = '42501';
    end if;
    target_id := gen_random_uuid();
    insert into public.post_targets (
      id,
      owner_id,
      post_id,
      connected_account_id,
      platform,
      status,
      metadata,
      selected_media_ids,
      scheduled_at_utc,
      idempotency_key
    ) values (
      target_id,
      owner,
      created_post_id,
      account_id,
      (target ->> 'platform')::public.social_platform,
      case when account_id is null then 'blocked_authorization'::public.target_status else 'scheduled'::public.target_status end,
      coalesce(target -> 'metadata', '{}'::jsonb),
      selected_media_ids,
      p_scheduled_at_utc,
      'post:' || created_post_id || ':target:' || target_id || ':v1'
    );
  end loop;

  insert into public.audit_log (owner_id, actor_user_id, action, entity_type, entity_id, safe_metadata)
  values (owner, owner, 'post.scheduled', 'post', created_post_id::text, jsonb_build_object('target_count', target_count, 'owner_email_hash', encode(digest(owner_email, 'sha256'), 'hex')));
  return created_post_id;
end;
$$;

revoke all on function public.create_scheduled_post(text, text, timestamptz, uuid[], jsonb) from public, anon;
grant execute on function public.create_scheduled_post(text, text, timestamptz, uuid[], jsonb) to authenticated;

create or replace function public.consume_rate_limit(
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
  owner uuid := auth.uid();
  window_time timestamptz;
  current_count integer;
begin
  if owner is null or not app_private.is_owner(owner) then
    return false;
  end if;
  window_time := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_buckets (owner_id, route, window_started_at, request_count)
  values (owner, p_route, window_time, 1)
  on conflict (owner_id, route, window_started_at)
  do update set request_count = public.rate_limit_buckets.request_count + 1
  returning request_count into current_count;
  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.consume_rate_limit(text, integer, integer) to authenticated;

create or replace function public.delete_installation_data(p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('request.jwt.claim.role', true) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  delete from public.posts where owner_id = p_owner_id;
  delete from public.media_assets where owner_id = p_owner_id;
  delete from public.oauth_states where owner_id = p_owner_id;
  delete from public.connected_accounts where owner_id = p_owner_id;
  delete from public.email_events where owner_id = p_owner_id;
  delete from public.analytics_snapshots where owner_id = p_owner_id;
  delete from public.rate_limit_buckets where owner_id = p_owner_id;
  delete from public.audit_log where owner_id = p_owner_id;
  delete from public.installation_settings where owner_id = p_owner_id;
end;
$$;

revoke all on function public.delete_installation_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_installation_data(uuid) to service_role;

create or replace function app_private.audit_target_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_log (
      owner_id,
      actor_user_id,
      action,
      entity_type,
      entity_id,
      safe_metadata
    ) values (
      new.owner_id,
      auth.uid(),
      'target.status_changed',
      'post_target',
      new.id::text,
      jsonb_build_object('from', old.status, 'to', new.status, 'platform', new.platform)
    );
  end if;
  return new;
end;
$$;

create trigger audit_target_status_change
after update of status on public.post_targets
for each row execute function app_private.audit_target_status_change();

create or replace function app_private.audit_account_connection_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.connection_status is distinct from old.connection_status then
    insert into public.audit_log (
      owner_id,
      actor_user_id,
      action,
      entity_type,
      entity_id,
      safe_metadata
    ) values (
      new.owner_id,
      auth.uid(),
      case when tg_op = 'INSERT' then 'account.connected' else 'account.connection_changed' end,
      'connected_account',
      new.id::text,
      jsonb_build_object('platform', new.platform, 'status', new.connection_status)
    );
  end if;
  return new;
end;
$$;

create trigger audit_account_connection_change
after insert or update of connection_status on public.connected_accounts
for each row execute function app_private.audit_account_connection_change();

commit;
