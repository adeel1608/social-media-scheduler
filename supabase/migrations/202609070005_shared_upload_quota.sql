begin;

-- The documented 2 GB UploadThing app has an existing 1.8 GiB application
-- safety ceiling (1932735283 bytes). The NEW reviewer sub-budget is one quarter
-- of that ceiling, rounded down, not a claim about a separate provider plan.
create function app_private.reserve_workspace_media(
  p_user_id uuid, p_context text, p_original_filename text, p_mime_type text,
  p_size_bytes bigint, p_width integer, p_height integer, p_duration_seconds numeric
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  media_id uuid := gen_random_uuid(); review_generation uuid;
  application_bytes numeric; workspace_bytes numeric;
  application_limit constant bigint := 1932735283;
  reviewer_limit constant bigint := 483183820;
  workspace_limit bigint;
begin
  if p_context = 'owner' then
    if p_user_id is null or p_user_id is distinct from auth.uid() or not app_private.is_owner(p_user_id) then
      raise exception 'Owner authorization required' using errcode = '42501';
    end if;
    workspace_limit := application_limit;
  elsif p_context = 'meta_review' then
    review_generation := app_private.current_review_generation(p_user_id);
    if review_generation is null then raise exception 'Meta reviewer authorization required' using errcode = '42501'; end if;
    workspace_limit := reviewer_limit;
  else raise exception 'Invalid workspace' using errcode = '42501'; end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_original_filename is null
    or length(p_original_filename) not between 1 and 255 or p_mime_type is null
    or not (p_mime_type ~ '^(image|video)/' or p_mime_type = 'application/octet-stream')
  then raise exception 'Invalid media reservation' using errcode = '22023'; end if;
  if p_size_bytes > workspace_limit then
    raise exception 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: reservation unavailable' using errcode = 'P0001';
  end if;
  -- Both paths acquire the same transaction mutex BEFORE reading either sum.
  perform pg_advisory_xact_lock(7307002);
  select coalesce(sum(size_bytes), 0),
    coalesce(sum(size_bytes) filter (where owner_id = p_user_id), 0)
  into application_bytes, workspace_bytes from public.media_assets
  where storage_provider = 'uploadthing' and deleted_at is null;
  -- SUM(bigint) is numeric: no overflow from hostile signed-bigint input or totals.
  if application_bytes + p_size_bytes > application_limit or workspace_bytes + p_size_bytes > workspace_limit then
    -- Same error for all limits: never return another identity's usage/details.
    raise exception 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: reservation unavailable' using errcode = 'P0001';
  end if;
  if p_context = 'meta_review' and review_generation is distinct from app_private.current_review_generation(p_user_id) then
    raise exception 'Meta reviewer authorization required' using errcode = '42501';
  end if;
  insert into public.media_assets (
    id, owner_id, authorization_context, authorization_generation, object_key,
    original_filename, mime_type, size_bytes, width, height, duration_seconds,
    upload_status, storage_provider, reservation_expires_at
  ) values (media_id, p_user_id, p_context, review_generation, 'reservation:' || media_id,
    p_original_filename, p_mime_type, p_size_bytes, p_width, p_height, p_duration_seconds,
    'uploading', 'uploadthing', now() + interval '24 hours');
  return media_id;
end;
$$;
revoke all on function app_private.reserve_workspace_media(uuid, text, text, text, bigint, integer, integer, numeric)
from public, anon, authenticated;

create or replace function public.reserve_uploadthing_media(
  p_original_filename text, p_mime_type text, p_size_bytes bigint,
  p_width integer default null, p_height integer default null, p_duration_seconds numeric default null
)
returns uuid language sql security definer set search_path = public, pg_temp
as $$
  select app_private.reserve_workspace_media(auth.uid(), 'owner', p_original_filename,
    p_mime_type, p_size_bytes, p_width, p_height, p_duration_seconds)
$$;
revoke all on function public.reserve_uploadthing_media(text, text, bigint, integer, integer, numeric)
from public, anon, authenticated;
grant execute on function public.reserve_uploadthing_media(text, text, bigint, integer, integer, numeric) to authenticated;

create or replace function public.reserve_meta_review_media(
  p_reviewer_id uuid, p_original_filename text, p_mime_type text, p_size_bytes bigint,
  p_width integer default null, p_height integer default null, p_duration_seconds numeric default null
)
returns uuid language sql security definer set search_path = public, pg_temp
as $$
  select app_private.reserve_workspace_media(p_reviewer_id, 'meta_review', p_original_filename,
    p_mime_type, p_size_bytes, p_width, p_height, p_duration_seconds)
$$;
revoke all on function public.reserve_meta_review_media(uuid, text, text, bigint, integer, integer, numeric)
from public, anon, authenticated;
grant execute on function public.reserve_meta_review_media(uuid, text, text, bigint, integer, integer, numeric) to service_role;

create or replace function public.meta_review_storage_usage(p_reviewer_id uuid)
returns table(active_bytes bigint, reserved_bytes bigint, limit_bytes bigint)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if app_private.current_review_generation(p_reviewer_id) is null then
    raise exception 'Meta reviewer authorization required' using errcode = '42501';
  end if;
  return query select coalesce(sum(size_bytes), 0)::bigint,
    coalesce(sum(size_bytes) filter (where upload_status <> 'complete'), 0)::bigint, 483183820::bigint
  from public.media_assets where owner_id = p_reviewer_id and storage_provider = 'uploadthing' and deleted_at is null;
end;
$$;
revoke all on function public.meta_review_storage_usage(uuid) from public, anon, authenticated;
grant execute on function public.meta_review_storage_usage(uuid) to service_role;

commit;
