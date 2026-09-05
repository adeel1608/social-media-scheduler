begin;

alter table public.email_events
  add column delivery_attempts integer not null default 0
    check (delivery_attempts >= 0),
  add column last_attempt_at timestamptz,
  add column next_attempt_at timestamptz not null default now();

create index email_events_delivery_retry_idx
on public.email_events (next_attempt_at, created_at)
where status in ('pending', 'failed');

create or replace function app_private.enqueue_target_failure_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  attempt_number integer;
begin
  if new.status not in ('failed', 'needs_review')
     or new.status is not distinct from old.status then
    return new;
  end if;

  select coalesce(max(candidate.attempt_number), 1)
  into attempt_number
  from public.publish_attempts candidate
  where candidate.post_target_id = new.id;

  insert into public.email_events (
    owner_id,
    post_target_id,
    event_type,
    deduplication_key
  ) values (
    new.owner_id,
    new.id,
    case
      when new.status = 'needs_review' then 'target_needs_review'
      else 'target_failed'
    end,
    'failure:' || new.id::text || ':attempt:' || attempt_number::text
  )
  on conflict (deduplication_key) do nothing;

  return new;
end;
$$;

revoke all on function app_private.enqueue_target_failure_email()
from public, anon, authenticated;

drop trigger if exists post_targets_enqueue_failure_email
on public.post_targets;
create trigger post_targets_enqueue_failure_email
after update of status on public.post_targets
for each row
execute function app_private.enqueue_target_failure_email();

commit;
