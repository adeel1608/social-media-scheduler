begin;

select plan(9);

select ok(
  to_regprocedure('public.claim_stale_targets(text,integer,integer,integer)') is not null,
  'claim_stale_targets exists with the expected signature'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_stale_targets(text,integer,integer,integer)',
    'execute'
  ),
  'service_role can execute claim_stale_targets'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_stale_targets(text,integer,integer,integer)',
    'execute'
  ),
  'authenticated cannot execute claim_stale_targets'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.claim_stale_targets(text,integer,integer,integer)',
    'execute'
  ),
  'anon cannot execute claim_stale_targets'
);

set local "request.jwt.claim.role" = 'service_role';
set local role service_role;
select is(
  (
    select count(*)
    from public.claim_stale_targets('migration-verification', 0, 900, 300)
  ),
  0::bigint,
  'service_role can execute a non-mutating claim preflight'
);

reset role;
select ok(
  to_regprocedure('app_private.enqueue_target_failure_email()') is not null,
  'notification reconciliation trigger function exists'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'post_targets_enqueue_failure_email'
      and not tgisinternal
  ),
  'terminal target transitions atomically enqueue a notification event'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'email_events'
      and column_name = 'delivery_attempts'
      and is_nullable = 'NO'
  ),
  'notification delivery attempts are persisted'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'email_events'
      and column_name = 'next_attempt_at'
      and is_nullable = 'NO'
  ),
  'notification retry scheduling is persisted'
);

select * from finish();
rollback;
