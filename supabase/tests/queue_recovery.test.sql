begin;

select plan(30);

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

select ok(
  to_regclass('public.account_disconnect_transactions') is not null,
  'durable account disconnect transaction table exists'
);

select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.account_disconnect_transactions'::regclass
  ),
  'durable account disconnect transactions enforce RLS'
);

select ok(
  to_regprocedure('public.begin_account_disconnect(uuid,uuid)') is not null,
  'begin_account_disconnect exists'
);

select ok(
  to_regprocedure('public.mark_account_disconnect_revocation_started(uuid,uuid,uuid)') is not null,
  'disconnect write-ahead marker function exists'
);

select ok(
  to_regprocedure('public.record_account_disconnect_revocation(uuid,uuid,uuid,text)') is not null,
  'disconnect provider result function exists'
);

select ok(
  to_regprocedure('public.complete_account_disconnect(uuid,uuid,uuid,boolean)') is not null,
  'atomic disconnect cleanup function exists'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.begin_account_disconnect(uuid,uuid)',
    'execute'
  ),
  'authenticated clients cannot forge disconnect transitions'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_account_disconnect(uuid,uuid)',
    'execute'
  ),
  'service_role can begin disconnect transactions'
);

insert into auth.users (id, email)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'phase2b-owner@example.test'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'phase2b-other@example.test');

insert into public.connected_accounts (
  id,
  owner_id,
  platform,
  remote_account_id,
  encrypted_access_token,
  access_token_nonce,
  encryption_key_version,
  approval_state
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'instagram',
  'phase2b-account',
  'test-ciphertext',
  'test-nonce',
  'v1',
  'approved'
);

insert into public.posts (id, owner_id, title)
values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Phase 2B notification trigger test'
);

insert into public.post_targets (
  id,
  owner_id,
  post_id,
  connected_account_id,
  platform,
  status,
  scheduled_at_utc,
  idempotency_key
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'instagram',
  'processing',
  now(),
  'phase2b-notification-test'
);

insert into public.publish_attempts (
  owner_id,
  post_target_id,
  attempt_number,
  idempotency_key
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  1,
  'phase2b-notification-test'
);

set local "request.jwt.claim.role" = 'service_role';
set local role service_role;

create temp table phase2b_disconnect_state as
select
  (
    public.begin_account_disconnect(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    ) ->> 'operation_id'
  )::uuid as operation_id;

select is(
  (
    select state
    from public.account_disconnect_transactions
    where account_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  'prepared',
  'disconnect begins in a durable prepared state'
);

select is(
  (
    public.mark_account_disconnect_revocation_started(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      (select operation_id from phase2b_disconnect_state)
    ) ->> 'should_revoke'
  )::boolean,
  true,
  'the first marker transition authorizes exactly one provider revocation'
);

select is(
  (
    public.mark_account_disconnect_revocation_started(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      (select operation_id from phase2b_disconnect_state)
    ) ->> 'should_revoke'
  )::boolean,
  false,
  'duplicate DELETE cannot authorize a second provider revocation'
);

select throws_ok(
  $$select public.begin_account_disconnect(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  )$$,
  'P0001',
  'account not found',
  'a different owner cannot resume the disconnect'
);

update public.account_disconnect_transactions
set expires_at = now() - interval '1 second'
where account_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

select throws_ok(
  format(
    $$select public.complete_account_disconnect(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      %L
    )$$,
    (select operation_id from phase2b_disconnect_state)
  ),
  'P0001',
  'disconnect transaction expired',
  'expired cleanup authorization cannot be used'
);

alter table phase2b_disconnect_state add column old_operation_id uuid;
update phase2b_disconnect_state set old_operation_id = operation_id;
update phase2b_disconnect_state
set operation_id = (
  public.begin_account_disconnect(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) ->> 'operation_id'
)::uuid;

select isnt(
  (select operation_id from phase2b_disconnect_state),
  (select old_operation_id from phase2b_disconnect_state),
  'resuming expired cleanup rotates the account-bound operation ID'
);

select is(
  (
    public.complete_account_disconnect(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      (select operation_id from phase2b_disconnect_state),
      true
    ) ->> 'completed_now'
  )::boolean,
  true,
  'cleanup atomically completes after revocation was started'
);

select is(
  (
    select provider_outcome
    from public.account_disconnect_transactions
    where account_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  'confirmed',
  'atomic cleanup preserves the confirmed provider outcome'
);

select is(
  (
    select connection_status::text
    from public.connected_accounts
    where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  'disconnected',
  'atomic cleanup disconnects the local account'
);

select is(
  (
    public.complete_account_disconnect(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      (select operation_id from phase2b_disconnect_state)
    ) ->> 'completed_now'
  )::boolean,
  false,
  'completed cleanup is replay-safe and performs no second cleanup'
);

update public.connected_accounts
set connection_status = 'connected',
    encrypted_access_token = 'new-test-ciphertext',
    access_token_nonce = 'new-test-nonce'
where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

select is(
  (
    select count(*)
    from public.account_disconnect_transactions
    where account_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  0::bigint,
  'a new OAuth credential clears the prior disconnect tombstone'
);

update public.post_targets
set status = 'failed'
where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
update public.post_targets
set last_error_message = 'same terminal state'
where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

select is(
  (
    select count(*)
    from public.email_events
    where post_target_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      and event_type = 'target_failed'
  ),
  1::bigint,
  'an actual qualifying target transition creates exactly one notification event'
);

select is(
  (public.verify_phase_2b_schema() ->> 'ready')::boolean,
  true,
  'the non-mutating production Phase 2B schema preflight reports ready'
);

reset role;

select * from finish();
rollback;
