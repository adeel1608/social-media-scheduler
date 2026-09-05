begin;

-- PostgREST assumes the service_role database role for both legacy
-- service-role JWTs and current secret server keys. Authorize this preflight
-- through PostgreSQL function privileges instead of request-scoped JWT GUCs,
-- which are not populated consistently for every supported key style.
create or replace function public.verify_phase_2b_schema()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ready',
    to_regclass('public.account_disconnect_transactions') is not null
    and to_regprocedure('public.begin_account_disconnect(uuid,uuid)') is not null
    and to_regprocedure('public.mark_account_disconnect_revocation_started(uuid,uuid,uuid)') is not null
    and to_regprocedure('public.record_account_disconnect_revocation(uuid,uuid,uuid,text)') is not null
    and to_regprocedure('public.complete_account_disconnect(uuid,uuid,uuid,boolean)') is not null
    and exists (
      select 1
      from pg_trigger
      where tgname = 'connected_accounts_clear_disconnect_on_reconnect'
        and not tgisinternal
    )
  );
$$;

revoke all on function public.verify_phase_2b_schema()
from public, anon, authenticated;
grant execute on function public.verify_phase_2b_schema()
to service_role;

commit;
