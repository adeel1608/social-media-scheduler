-- No reviewer is activated by this migration. Explicit, expiring authorization
-- and current Worker configuration must BOTH authorize privileged review work.
begin;

create table public.meta_review_authorization (
  singleton boolean primary key default true check (singleton),
  reviewer_user_id uuid not null,
  reviewer_email text not null check (reviewer_email = lower(trim(reviewer_email))),
  generation uuid not null default gen_random_uuid(),
  enabled boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.meta_review_authorization enable row level security;
revoke all on table public.meta_review_authorization from public, anon, authenticated;
grant all on table public.meta_review_authorization to service_role;

alter table public.oauth_states add column browser_binding_hash text;
alter table public.oauth_states add column auth_session_id uuid;
alter table public.oauth_states add column initiating_email text;
alter table public.oauth_states add column authorization_generation uuid;
alter table public.connected_accounts add column authorization_generation uuid;
alter table public.posts add column authorization_context text not null default 'owner'
  check (authorization_context in ('owner', 'meta_review'));
alter table public.posts add column authorization_generation uuid;
alter table public.media_assets add column authorization_context text not null default 'owner'
  check (authorization_context in ('owner', 'meta_review'));
alter table public.media_assets add column authorization_generation uuid;
alter table public.post_targets add column authorization_generation uuid;

-- Old reviewer objects do not acquire authority retroactively. They remain
-- generation-less and cannot be executed under a newly activated review window.
update public.posts p set authorization_context = 'meta_review'
where exists (select 1 from public.post_targets t where t.post_id = p.id
  and t.authorization_context = 'meta_review');
update public.media_assets m set authorization_context = 'meta_review'
where exists (select 1 from public.post_media pm join public.posts p on p.id = pm.post_id
  where pm.media_asset_id = m.id and p.owner_id = m.owner_id
    and p.authorization_context = 'meta_review');

create function app_private.current_review_generation(p_user_id uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$
  select a.generation from public.meta_review_authorization a
  join auth.users u on u.id = a.reviewer_user_id
  where a.singleton and a.enabled and a.revoked_at is null
    and a.expires_at > now() and a.reviewer_user_id = p_user_id
    and lower(u.email) = a.reviewer_email
    and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
    and u.email_confirmed_at is not null
    and coalesce(u.encrypted_password, '') <> ''
    and not exists (select 1 from public.installation_settings s where s.owner_id = u.id)
$$;
revoke all on function app_private.current_review_generation(uuid) from public, anon, authenticated;

create function public.current_meta_review_authorization(p_user_id uuid, p_email text)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('generation', a.generation)
  from public.meta_review_authorization a
  where a.reviewer_user_id = p_user_id and a.reviewer_email = p_email
    and a.generation = app_private.current_review_generation(p_user_id)
$$;
revoke all on function public.current_meta_review_authorization(uuid, text) from public, anon, authenticated;
grant execute on function public.current_meta_review_authorization(uuid, text) to service_role;

-- Explicit operator-only activation/revocation; never invoked automatically by
-- a login, request, callback, queue worker, preflight or deployment workflow.
create function public.set_meta_review_authorization(
  p_user_id uuid, p_email text, p_enabled boolean, p_expires_at timestamptz
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare new_generation uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(7307001);
  if p_enabled and (
    p_email is null or p_email <> lower(trim(p_email))
    or p_expires_at is null or p_expires_at <= now()
    or not exists (select 1 from auth.users u where u.id = p_user_id
      and lower(u.email) = p_email and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and u.email_confirmed_at is not null and coalesce(u.encrypted_password, '') <> '')
    or exists (select 1 from public.installation_settings s where s.owner_id = p_user_id)
  ) then raise exception 'Invalid reviewer authorization' using errcode = '42501'; end if;
  insert into public.meta_review_authorization (
    singleton, reviewer_user_id, reviewer_email, generation, enabled, expires_at, revoked_at
  ) values (true, p_user_id, p_email, new_generation, p_enabled,
    p_expires_at, case when p_enabled then null else now() end)
  on conflict (singleton) do update set
    reviewer_user_id = excluded.reviewer_user_id, reviewer_email = excluded.reviewer_email,
    generation = excluded.generation, enabled = excluded.enabled,
    expires_at = excluded.expires_at, revoked_at = excluded.revoked_at, updated_at = now();
  return new_generation;
end;
$$;
revoke all on function public.set_meta_review_authorization(uuid, text, boolean, timestamptz)
from public, anon, authenticated;
grant execute on function public.set_meta_review_authorization(uuid, text, boolean, timestamptz) to service_role;

create function app_private.invalidate_review_work()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  -- All generations preceding a replacement or revocation remain invalid even
  -- if the same email/UUID is later re-enabled. Never clear publication markers.
  update public.oauth_states set consumed_at = coalesce(consumed_at, now())
  where authorization_context = 'meta_review'
    and authorization_generation is distinct from new.generation;
  update public.post_targets set
    status = case when publish_request_sent_at is not null
      then 'needs_review'::public.target_status else 'blocked_authorization'::public.target_status end,
    last_error_code = 'meta_review_authorization_revoked',
    last_error_message = 'The review authorization is no longer valid.',
    lease_owner = null, lease_expires_at = null, updated_at = now()
  where authorization_context = 'meta_review'
    and status in ('scheduled', 'queued', 'publishing', 'processing', 'blocked_authorization')
    and (not new.enabled or authorization_generation is distinct from new.generation);
  return new;
end;
$$;
revoke all on function app_private.invalidate_review_work() from public, anon, authenticated;
create trigger meta_review_authorization_invalidates_work
after insert or update on public.meta_review_authorization
for each row execute function app_private.invalidate_review_work();

create function app_private.revoke_review_on_auth_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.meta_review_authorization set enabled = false, revoked_at = now(),
    generation = gen_random_uuid(), updated_at = now()
  where reviewer_user_id = old.id;
  return old;
end;
$$;
revoke all on function app_private.revoke_review_on_auth_change() from public, anon, authenticated;
create trigger postline_revoke_review_on_auth_update
after update of email, banned_until, deleted_at, encrypted_password on auth.users
for each row when (
  old.email is distinct from new.email or old.banned_until is distinct from new.banned_until
  or old.deleted_at is distinct from new.deleted_at
  or old.encrypted_password is distinct from new.encrypted_password
) execute function app_private.revoke_review_on_auth_change();
create trigger postline_revoke_review_on_auth_delete
before delete on auth.users for each row execute function app_private.revoke_review_on_auth_change();

commit;
