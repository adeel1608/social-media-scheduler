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
  values (owner, owner, 'post.scheduled', 'post', created_post_id::text, jsonb_build_object('target_count', target_count, 'owner_email_hash', encode(extensions.digest(owner_email, 'sha256'), 'hex')));
  return created_post_id;
end;
$$;

revoke all on function public.create_scheduled_post(text, text, timestamptz, uuid[], jsonb) from public, anon;
grant execute on function public.create_scheduled_post(text, text, timestamptz, uuid[], jsonb) to authenticated;

-- Supabase's automatic-RLS event trigger does not need to be callable through
-- PostgREST. Keep the event trigger active while removing inherited RPC access.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

commit;
