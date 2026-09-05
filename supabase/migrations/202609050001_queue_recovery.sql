begin;

create or replace function public.claim_stale_targets(
  p_worker_id text,
  p_limit integer default 100,
  p_stale_seconds integer default 900,
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

  return query
  with stale as (
    select candidate.id
    from public.post_targets candidate
    where candidate.status in ('publishing', 'processing')
      and candidate.updated_at <= now() - make_interval(
        secs => greatest(300, least(p_stale_seconds, 86400))
      )
      and (
        candidate.lease_expires_at is null
        or candidate.lease_expires_at <= now()
      )
    order by candidate.updated_at, candidate.id
    for update skip locked
    limit greatest(1, least(p_limit, 500))
  )
  update public.post_targets claimed
  set lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(
        secs => greatest(30, least(p_lease_seconds, 900))
      ),
      updated_at = now()
  from stale
  where claimed.id = stale.id
  returning claimed.*;
end;
$$;

revoke all on function public.claim_stale_targets(text, integer, integer, integer)
from public, anon, authenticated;
grant execute on function public.claim_stale_targets(text, integer, integer, integer)
to service_role;

commit;
