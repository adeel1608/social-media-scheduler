begin;

alter table public.media_assets
  add column storage_provider text,
  add column provider_file_key text,
  add column provider_url text,
  add column reservation_expires_at timestamptz,
  add column deletion_status text not null default 'not_requested',
  add column deletion_attempted_at timestamptz,
  add column provider_deleted_at timestamptz,
  add column deletion_last_error text;

update public.media_assets
set storage_provider = 'r2'
where storage_provider is null;

alter table public.media_assets
  -- Keep the legacy default during rolling deployment. Current UploadThing
  -- writes explicitly set their provider inside reserve_uploadthing_media.
  alter column storage_provider set default 'r2',
  alter column storage_provider set not null,
  add constraint media_assets_storage_provider_check
    check (storage_provider in ('r2', 'uploadthing')),
  add constraint media_assets_deletion_status_check
    check (deletion_status in ('not_requested', 'pending', 'confirmed', 'failed')),
  add constraint media_assets_provider_url_https_check
    check (provider_url is null or provider_url ~ '^https://'),
  add constraint media_assets_uploadthing_complete_check
    check (
      storage_provider <> 'uploadthing'
      or upload_status <> 'complete'
      or (provider_file_key is not null and provider_url is not null)
    );

alter table public.media_assets
  drop constraint media_assets_mime_type_check,
  add constraint media_assets_mime_type_check
    check (mime_type ~ '^(image|video)/' or mime_type = 'application/octet-stream');

create unique index media_assets_provider_file_key_idx
  on public.media_assets (provider_file_key)
  where provider_file_key is not null;

create index media_assets_uploadthing_quota_idx
  on public.media_assets (owner_id, upload_status, deleted_at)
  include (size_bytes)
  where storage_provider = 'uploadthing';

create index media_assets_reservation_expiry_idx
  on public.media_assets (reservation_expires_at)
  where storage_provider = 'uploadthing'
    and upload_status = 'uploading'
    and deleted_at is null;

create or replace function public.reserve_uploadthing_media(
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint,
  p_width integer default null,
  p_height integer default null,
  p_duration_seconds numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner uuid := auth.uid();
  created_media_id uuid := gen_random_uuid();
  used_bytes bigint;
  active_media_limit constant bigint := 1932735283;
begin
  if owner is null or not app_private.is_owner(owner) then
    raise exception 'Owner authorization required' using errcode = '42501';
  end if;
  if p_size_bytes <= 0
    or p_original_filename is null
    or char_length(p_original_filename) not between 1 and 255
    or not (p_mime_type ~ '^(image|video)/' or p_mime_type = 'application/octet-stream')
  then
    raise exception 'Invalid media reservation' using errcode = '22023';
  end if;
  if p_size_bytes > active_media_limit then
    raise exception 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: file exceeds 1.8 GiB' using errcode = 'P0001';
  end if;

  -- The single installation row is the quota mutex. Every concurrent
  -- reservation for this owner must acquire it before summing and inserting.
  perform 1
  from public.installation_settings settings
  where settings.owner_id = owner
  for update;
  if not found then
    raise exception 'Installation settings are required' using errcode = '42501';
  end if;

  select coalesce(sum(size_bytes), 0)
  into used_bytes
  from public.media_assets
  where owner_id = owner
    and storage_provider = 'uploadthing'
    and deleted_at is null
    and upload_status in ('uploading', 'complete');

  if used_bytes + p_size_bytes > active_media_limit then
    raise exception 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: active and reserved media exceed 1.8 GiB' using errcode = 'P0001';
  end if;

  insert into public.media_assets (
    id,
    owner_id,
    object_key,
    original_filename,
    mime_type,
    size_bytes,
    width,
    height,
    duration_seconds,
    upload_status,
    storage_provider,
    reservation_expires_at
  ) values (
    created_media_id,
    owner,
    'reservation:' || created_media_id::text,
    p_original_filename,
    p_mime_type,
    p_size_bytes,
    p_width,
    p_height,
    p_duration_seconds,
    'uploading',
    'uploadthing',
    now() + interval '24 hours'
  );

  return created_media_id;
end;
$$;

revoke all on function public.reserve_uploadthing_media(text, text, bigint, integer, integer, numeric) from public, anon;
grant execute on function public.reserve_uploadthing_media(text, text, bigint, integer, integer, numeric) to authenticated;

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
  if current_setting('request.jwt.claim.role', true) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
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

create or replace function public.uploadthing_storage_usage()
returns table(active_bytes bigint, reserved_bytes bigint, limit_bytes bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    coalesce(sum(size_bytes), 0)::bigint as active_bytes,
    coalesce(sum(size_bytes) filter (where upload_status = 'uploading'), 0)::bigint as reserved_bytes,
    1932735283::bigint as limit_bytes
  from public.media_assets
  where owner_id = auth.uid()
    and app_private.is_owner(owner_id)
    and storage_provider = 'uploadthing'
    and deleted_at is null
    and upload_status in ('uploading', 'complete');
$$;

revoke all on function public.uploadthing_storage_usage() from public, anon;
grant execute on function public.uploadthing_storage_usage() to authenticated;

commit;
