begin;

select plan(31);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'analytics_snapshots'
      and column_name = 'authorization_generation'
      and data_type = 'uuid'
  ),
  'analytics snapshots carry an authorization generation'
);
select ok(
  exists (
    select 1 from pg_index
    where indexrelid = 'public.analytics_snapshots_review_generation_idx'::regclass
      and indisvalid
  ),
  'reviewer analytics generation index is valid'
);
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.analytics_snapshots'::regclass
      and tgname = 'analytics_snapshots_guard_generation'
      and tgenabled = 'O'
  ),
  'analytics generation trigger is enabled'
);
select ok(
  exists (
    select 1 from pg_proc
    where oid = 'public.list_meta_review_analytics(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure
      and provolatile = 's'
      and prosecdef
      and proowner = (select oid from pg_roles where rolname = 'postgres')
      and proconfig @> array['search_path=public, pg_temp']
  ),
  'review analytics RPC is stable, security definer, postgres-owned and has a fixed search path'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.list_meta_review_analytics(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer)',
    'execute'
  ),
  'service role may execute the reviewer analytics RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.list_meta_review_analytics(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer)',
    'execute'
  ),
  'anon cannot execute the reviewer analytics RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.list_meta_review_analytics(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,integer)',
    'execute'
  ),
  'authenticated cannot execute the reviewer analytics RPC'
);
select ok(
  not has_table_privilege('service_role', 'public.analytics_snapshots', 'select'),
  'service role cannot bypass the generation-aware analytics RPC'
);
select ok(
  has_table_privilege('service_role', 'public.analytics_snapshots', 'insert'),
  'service role retains the bounded analytics write capability'
);

insert into auth.users (id, email, email_confirmed_at, encrypted_password)
values
  ('71000000-0000-4000-8000-000000000001', 'analytics-owner@example.test', now(), 'owner-password-hash'),
  ('71000000-0000-4000-8000-000000000002', 'analytics-reviewer@example.test', now(), 'review-password-hash'),
  ('71000000-0000-4000-8000-000000000003', 'analytics-unrelated@example.test', now(), 'other-password-hash');
insert into public.installation_settings (owner_id, owner_email)
values ('71000000-0000-4000-8000-000000000001', 'analytics-owner@example.test');

create temp table analytics_generations (
  label text primary key,
  generation uuid not null
);
grant select on analytics_generations to service_role;
insert into analytics_generations values (
  'g1',
  public.set_meta_review_authorization(
    '71000000-0000-4000-8000-000000000002',
    'analytics-reviewer@example.test',
    true,
    now() + interval '1 hour'
  )
);

insert into public.connected_accounts (
  id, owner_id, platform, remote_account_id, encrypted_access_token,
  access_token_nonce, encryption_key_version, authorization_context,
  authorization_generation
)
values
  (
    '71000000-0000-4000-8000-000000000011',
    '71000000-0000-4000-8000-000000000001',
    'instagram', 'analytics-owner-account', 'cipher', 'nonce', 'v1',
    'owner', null
  ),
  (
    '71000000-0000-4000-8000-000000000012',
    '71000000-0000-4000-8000-000000000002',
    'instagram', 'analytics-review-g1', 'cipher', 'nonce', 'v1',
    'meta_review', (select generation from analytics_generations where label = 'g1')
  );
insert into public.posts (
  id, owner_id, title, base_caption, authorization_context,
  authorization_generation
)
values
  (
    '71000000-0000-4000-8000-000000000021',
    '71000000-0000-4000-8000-000000000001',
    'Owner analytics title', '', 'owner', null
  ),
  (
    '71000000-0000-4000-8000-000000000022',
    '71000000-0000-4000-8000-000000000002',
    'G1 private analytics title', '', 'meta_review',
    (select generation from analytics_generations where label = 'g1')
  );
insert into public.post_targets (
  id, owner_id, post_id, connected_account_id, platform, status,
  scheduled_at_utc, idempotency_key, authorization_context,
  authorization_generation, metadata, remote_url
)
values
  (
    '71000000-0000-4000-8000-000000000031',
    '71000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000021',
    '71000000-0000-4000-8000-000000000011',
    'instagram', 'published', now(), 'owner-analytics-target', 'owner', null,
    '{"owner":"metadata"}', 'https://owner.invalid/private'
  ),
  (
    '71000000-0000-4000-8000-000000000032',
    '71000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000022',
    '71000000-0000-4000-8000-000000000012',
    'instagram', 'published', now(), 'g1-analytics-target', 'meta_review',
    (select generation from analytics_generations where label = 'g1'),
    '{"g1":"private-metadata"}', 'https://review.invalid/g1-private'
  );
insert into public.analytics_snapshots (
  id, owner_id, post_target_id, connected_account_id, platform,
  authorization_generation, normalized_metrics, raw_metrics
)
values
  (
    '71000000-0000-4000-8000-000000000041',
    '71000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000031',
    '71000000-0000-4000-8000-000000000011',
    'instagram', (select generation from analytics_generations where label = 'g1'),
    '{"owner":1}', '{"owner_raw":2}'
  ),
  (
    '71000000-0000-4000-8000-000000000042',
    '71000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000032',
    '71000000-0000-4000-8000-000000000012',
    'instagram', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    '{"g1":1}', '{"g1_raw":"private"}'
  );

select is(
  (
    select authorization_generation
    from public.analytics_snapshots
    where id = '71000000-0000-4000-8000-000000000042'
  ),
  (select generation from analytics_generations where label = 'g1'),
  'the trigger replaces a supplied generation with trusted G1 lineage'
);
select is(
  (
    select authorization_generation
    from public.analytics_snapshots
    where id = '71000000-0000-4000-8000-000000000041'
  ),
  null::uuid,
  'owner analytics remain generation-independent'
);

set local role service_role;
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g1'),
      null, null, null, 500
    )
  ),
  1::bigint,
  'UUID A and G1 can list their own analytics'
);
select ok(
  exists (
    select 1
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g1'),
      '71000000-0000-4000-8000-000000000032', null, null, 500
    ) result
    where result.raw_metrics ->> 'g1_raw' = 'private'
      and result.post_targets -> 'posts' ->> 'title' = 'G1 private analytics title'
      and result.post_targets -> 'metadata' ->> 'g1' = 'private-metadata'
      and result.post_targets ->> 'remote_url' = 'https://review.invalid/g1-private'
  ),
  'authorized positive control returns the expected analytics and joined fields'
);
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      null, null, null, null, 500
    )
  ),
  0::bigint,
  'null generation fails closed'
);
select throws_ok(
  $$select * from public.list_meta_review_analytics(
    '71000000-0000-4000-8000-000000000002',
    'malformed'::uuid, null, null, null, 500
  )$$,
  '22P02',
  'invalid input syntax for type uuid: "malformed"',
  'malformed generation is rejected'
);
reset role;

set local "request.jwt.claims" = '{"sub":"71000000-0000-4000-8000-000000000001","email":"analytics-owner@example.test"}';
set local role authenticated;
select is(
  (select count(*) from public.analytics_snapshots),
  1::bigint,
  'owner analytics continue to work through owner RLS'
);
reset role;
set local "request.jwt.claims" = '{"sub":"71000000-0000-4000-8000-000000000002","email":"analytics-reviewer@example.test"}';
set local role authenticated;
select is(
  (select count(*) from public.analytics_snapshots),
  0::bigint,
  'reviewer has no direct analytics table access'
);
reset role;
set local "request.jwt.claims" = '{"sub":"71000000-0000-4000-8000-000000000003","email":"analytics-unrelated@example.test"}';
set local role authenticated;
select is(
  (select count(*) from public.analytics_snapshots),
  0::bigint,
  'unrelated user cannot read owner or reviewer analytics'
);
reset role;

select throws_ok(
  $$insert into public.analytics_snapshots (
    owner_id, post_target_id, connected_account_id, platform
  ) values (
    '71000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000031',
    '71000000-0000-4000-8000-000000000012',
    'instagram'
  )$$,
  '42501',
  'Analytics target isolation required',
  'cross-owner target and account lineage is rejected'
);

select public.set_meta_review_authorization(
  '71000000-0000-4000-8000-000000000002',
  'analytics-reviewer@example.test',
  false,
  now() + interval '1 hour'
);
insert into analytics_generations values (
  'g2',
  public.set_meta_review_authorization(
    '71000000-0000-4000-8000-000000000002',
    'analytics-reviewer@example.test',
    true,
    now() + interval '1 hour'
  )
);

set local role service_role;
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g2'),
      null, null, null, 500
    )
  ),
  0::bigint,
  'same UUID A under G2 cannot list G1 analytics'
);
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g2'),
      '71000000-0000-4000-8000-000000000032', null, null, 500
    )
  ),
  0::bigint,
  'same UUID A under G2 cannot directly access a G1 target'
);
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g1'),
      null, null, null, 500
    )
  ),
  0::bigint,
  'stale G1 cannot read after authorization rotation'
);
reset role;

select throws_ok(
  $$insert into public.analytics_snapshots (
    owner_id, post_target_id, connected_account_id, platform
  ) values (
    '71000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000032',
    '71000000-0000-4000-8000-000000000012',
    'instagram'
  )$$,
  '42501',
  'Meta reviewer authorization required',
  'a stale G1 lineage cannot create analytics after G2 begins'
);
select is(
  (
    select authorization_generation
    from public.analytics_snapshots
    where id = '71000000-0000-4000-8000-000000000042'
  ),
  (select generation from analytics_generations where label = 'g1'),
  'generation rotation does not rewrite a G1 snapshot into G2'
);

insert into public.connected_accounts (
  id, owner_id, platform, remote_account_id, encrypted_access_token,
  access_token_nonce, encryption_key_version, authorization_context,
  authorization_generation
)
values (
  '71000000-0000-4000-8000-000000000013',
  '71000000-0000-4000-8000-000000000002',
  'instagram', 'analytics-review-g2', 'cipher', 'nonce', 'v1',
  'meta_review', (select generation from analytics_generations where label = 'g2')
);
insert into public.posts (
  id, owner_id, title, base_caption, authorization_context,
  authorization_generation
)
values (
  '71000000-0000-4000-8000-000000000023',
  '71000000-0000-4000-8000-000000000002',
  'G2 private analytics title', '', 'meta_review',
  (select generation from analytics_generations where label = 'g2')
);
insert into public.post_targets (
  id, owner_id, post_id, connected_account_id, platform, status,
  scheduled_at_utc, idempotency_key, authorization_context,
  authorization_generation, metadata, remote_url
)
values (
  '71000000-0000-4000-8000-000000000033',
  '71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000023',
  '71000000-0000-4000-8000-000000000013',
  'instagram', 'published', now(), 'g2-analytics-target', 'meta_review',
  (select generation from analytics_generations where label = 'g2'),
  '{"g2":"private-metadata"}', 'https://review.invalid/g2-private'
);
insert into public.analytics_snapshots (
  id, owner_id, post_target_id, connected_account_id, platform,
  normalized_metrics, raw_metrics
)
values (
  '71000000-0000-4000-8000-000000000043',
  '71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000033',
  '71000000-0000-4000-8000-000000000013',
  'instagram', '{"g2":1}', '{"g2_raw":"private"}'
);

set local role service_role;
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g2'),
      null, null, null, 500
    )
  ),
  1::bigint,
  'new G2 analytics are visible to G2'
);
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000002',
      (select generation from analytics_generations where label = 'g1'),
      '71000000-0000-4000-8000-000000000033', null, null, 500
    )
  ),
  0::bigint,
  'G1 cannot access G2 analytics through a guessed target'
);
reset role;

update auth.users
set email = 'analytics-reviewer-retired@example.test'
where id = '71000000-0000-4000-8000-000000000002';
insert into auth.users (id, email, email_confirmed_at, encrypted_password)
values (
  '71000000-0000-4000-8000-000000000004',
  'analytics-reviewer@example.test',
  now(),
  'replacement-password-hash'
);
insert into analytics_generations values (
  'replacement',
  public.set_meta_review_authorization(
    '71000000-0000-4000-8000-000000000004',
    'analytics-reviewer@example.test',
    true,
    now() + interval '1 hour'
  )
);

set local role service_role;
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000004',
      (select generation from analytics_generations where label = 'replacement'),
      null, null, null, 500
    )
  ),
  0::bigint,
  'replacement UUID with the same email receives no earlier analytics'
);
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000004',
      (select generation from analytics_generations where label = 'replacement'),
      '71000000-0000-4000-8000-000000000033', null, null, 500
    )
  ),
  0::bigint,
  'replacement UUID cannot use a guessed G2 target'
);
select is(
  (
    select count(*)
    from public.list_meta_review_analytics(
      '71000000-0000-4000-8000-000000000099',
      (select generation from analytics_generations where label = 'replacement'),
      null, null, null, 500
    )
  ),
  0::bigint,
  'missing reviewer UUID fails closed'
);
reset role;

create temp table analytics_count_before as
select count(*) as value from public.analytics_snapshots;
set local role service_role;
select public.list_meta_review_analytics(
  '71000000-0000-4000-8000-000000000004',
  (select generation from analytics_generations where label = 'replacement'),
  null, null, null, 500
);
reset role;
select is(
  (select count(*) from public.analytics_snapshots),
  (select value from analytics_count_before),
  'review analytics RPC performs no writes'
);
select ok(
  (public.verify_meta_review_schema() ->> 'ready')::boolean,
  'schema preflight requires the generation-isolated analytics boundary'
);

select * from finish();
rollback;
