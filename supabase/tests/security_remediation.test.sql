begin;

select plan(47);

select ok(to_regclass('public.meta_review_authorization') is not null, 'durable reviewer authorization exists');
select ok((select relrowsecurity from pg_class where oid = 'public.meta_review_authorization'::regclass), 'review authorization enforces RLS');
select ok(has_function_privilege('service_role', 'public.set_meta_review_authorization(uuid,text,boolean,timestamp with time zone)', 'execute'), 'service role controls review authorization');
select ok(not has_function_privilege('anon', 'public.set_meta_review_authorization(uuid,text,boolean,timestamp with time zone)', 'execute'), 'anon cannot control review authorization');
select ok(not has_function_privilege('authenticated', 'public.set_meta_review_authorization(uuid,text,boolean,timestamp with time zone)', 'execute'), 'authenticated cannot control review authorization');
select ok(not has_function_privilege('authenticated', 'app_private.current_review_generation(uuid)', 'execute'), 'current generation helper remains private');

insert into auth.users (id, email, email_confirmed_at, encrypted_password)
values
  ('70000000-0000-4000-8000-000000000001', 'owner-security@example.test', now(), 'owner-password-hash'),
  ('70000000-0000-4000-8000-000000000002', 'review-security@example.test', now(), 'review-password-hash'),
  ('70000000-0000-4000-8000-000000000003', 'unrelated-security@example.test', now(), 'other-password-hash');
insert into public.installation_settings (owner_id, owner_email)
values ('70000000-0000-4000-8000-000000000001', 'owner-security@example.test');

create temp table security_generation (generation uuid);
grant select, insert, update on security_generation to service_role;
set local role service_role;
insert into security_generation select public.set_meta_review_authorization(
  '70000000-0000-4000-8000-000000000002', 'review-security@example.test', true, now() + interval '1 hour');
select ok((public.current_meta_review_authorization('70000000-0000-4000-8000-000000000002', 'review-security@example.test')->>'generation')::uuid
  = (select generation from security_generation), 'active current Auth identity resolves the grant');
reset role;

select is((select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'authorization_generation'
  and table_name in ('oauth_states','connected_accounts','posts','post_targets','media_assets')), 5::bigint, 'all review work carries a generation');
select ok(exists(select 1 from pg_index where indexrelid = 'public.connected_accounts_instagram_identity_unique'::regclass
  and indisunique and indisvalid), 'Instagram remote identity conflict is atomically unique');

insert into public.connected_accounts (id, owner_id, platform, remote_account_id, encrypted_access_token,
  access_token_nonce, encryption_key_version, authorization_context, authorization_generation)
values
 ('70000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000001','instagram','owner-remote','cipher','nonce','v1','owner',null),
 ('70000000-0000-4000-8000-000000000012','70000000-0000-4000-8000-000000000002','instagram','review-remote','cipher','nonce','v1','meta_review',(select generation from security_generation));
select throws_ok($$insert into public.connected_accounts (owner_id,platform,remote_account_id,encrypted_access_token,access_token_nonce,
  encryption_key_version,authorization_context,authorization_generation) values
 ('70000000-0000-4000-8000-000000000001','instagram','review-remote','cipher','nonce','v1','owner',null)$$,
 '23505', 'duplicate key value violates unique constraint "connected_accounts_instagram_identity_unique"',
 'same Instagram remote account cannot cross owner/reviewer contexts');

insert into public.media_assets (id, owner_id, object_key, original_filename, mime_type, size_bytes, upload_status,
  storage_provider, provider_file_key, provider_url, authorization_context, authorization_generation)
values
 ('70000000-0000-4000-8000-000000000021','70000000-0000-4000-8000-000000000001','owner-media','owner.jpg','image/jpeg',100,'complete','uploadthing','owner-media','https://fixture.ufs.sh/f/owner-media','owner',null),
 ('70000000-0000-4000-8000-000000000022','70000000-0000-4000-8000-000000000002','review-media','review.jpg','image/jpeg',100,'complete','uploadthing','review-media','https://fixture.ufs.sh/f/review-media','meta_review',(select generation from security_generation));
insert into public.posts (id,owner_id,title,base_caption,authorization_context,authorization_generation)
values
 ('70000000-0000-4000-8000-000000000031','70000000-0000-4000-8000-000000000001','Owner fenced post','','owner',null),
 ('70000000-0000-4000-8000-000000000032','70000000-0000-4000-8000-000000000002','Review fenced post','','meta_review',(select generation from security_generation));
insert into public.post_media(post_id,media_asset_id,sort_order) values
 ('70000000-0000-4000-8000-000000000031','70000000-0000-4000-8000-000000000021',0),
 ('70000000-0000-4000-8000-000000000032','70000000-0000-4000-8000-000000000022',0);
insert into public.post_targets(id,owner_id,post_id,connected_account_id,platform,status,selected_media_ids,
 scheduled_at_utc,idempotency_key,authorization_context,authorization_generation)
values
 ('70000000-0000-4000-8000-000000000041','70000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000031','70000000-0000-4000-8000-000000000011','instagram','queued',array['70000000-0000-4000-8000-000000000021'::uuid],now(),'owner-fence','owner',null),
 ('70000000-0000-4000-8000-000000000042','70000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000032','70000000-0000-4000-8000-000000000012','instagram','scheduled',array['70000000-0000-4000-8000-000000000022'::uuid],now(),'review-fence','meta_review',(select generation from security_generation));

insert into auth.sessions(id,user_id) values
 ('70000000-0000-4000-8000-000000000051','70000000-0000-4000-8000-000000000002');
insert into public.oauth_states(id,owner_id,platform,state_hash,redirect_uri,expires_at,authorization_context,
 authorization_generation,browser_binding_hash,auth_session_id,initiating_email,consumed_at)
values('70000000-0000-4000-8000-000000000052','70000000-0000-4000-8000-000000000002','instagram','bound-state',
 'https://callback.test',now()+interval '5 minutes','meta_review',(select generation from security_generation),repeat('b',64),
 '70000000-0000-4000-8000-000000000051','review-security@example.test',null);

set local role service_role;
select is((select count(*) from public.consume_bound_oauth_state('bound-state',repeat('c',64),'instagram',
 'owner-security@example.test',true,'70000000-0000-4000-8000-000000000002','review-security@example.test','https://callback.test')),
 0::bigint, 'wrong browser binding cannot consume OAuth state');
select is((select count(*) from public.consume_bound_oauth_state('bound-state',repeat('b',64),'instagram',
 'owner-security@example.test',true,'70000000-0000-4000-8000-000000000002','review-security@example.test','https://callback.test')),
 1::bigint, 'same session and browser binding atomically consumes OAuth state once');
select throws_ok($$select public.persist_bound_oauth_account(
 '70000000-0000-4000-8000-000000000052',repeat('b',64),
 '{"remote_account_id":"owner-remote","username":"conflict","encrypted_access_token":"cipher","access_token_nonce":"nonce","encryption_key_version":"v1","approval_state":"pending"}'::jsonb,
 'owner-security@example.test',true,'70000000-0000-4000-8000-000000000002','review-security@example.test','https://callback.test')$$,
 '23505', 'duplicate key value violates unique constraint "connected_accounts_instagram_identity_unique"',
 'conflicting remote identity is rejected inside atomic OAuth persistence');
create temp table claimed_owner as select * from public.claim_publication_target(
 '70000000-0000-4000-8000-000000000041','lease-one','owner-security@example.test',true,false,null,null,null);
select is((select count(*) from claimed_owner), 1::bigint, 'authorized owner target obtains one fenced lease');
select is((select count(*) from public.transition_publication_target(
 '70000000-0000-4000-8000-000000000041','lease-one',(select row_version from claimed_owner),'queued',null,
 'owner',null,0,jsonb_build_object('status','publishing','publish_request_sent_at',now()),
 'owner-security@example.test',true,false,null,null)), 1::bigint, 'current lease writes one durable provider marker');
select is((select count(*) from public.transition_publication_target(
 '70000000-0000-4000-8000-000000000041','lease-one',(select row_version from claimed_owner),'queued',null,
 'owner',null,0,'{}','owner-security@example.test',true,false,null,null)), 0::bigint, 'stale row version affects zero rows');
update public.post_targets set lease_expires_at=now()-interval '1 second'
where id='70000000-0000-4000-8000-000000000041';
select is((select count(*) from public.claim_publication_target(
 '70000000-0000-4000-8000-000000000041','lease-two','owner-security@example.test',true,false,null,null,null)), 0::bigint, 'lease takeover cannot cross a durable ambiguous marker');
select is((select status::text from public.post_targets where id='70000000-0000-4000-8000-000000000041'), 'needs_review', 'ambiguous takeover fails closed');
select ok(has_function_privilege('service_role','public.transition_publication_target(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)','execute'), 'service role may use fenced transitions');
select ok(not has_function_privilege('authenticated','public.transition_publication_target(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)','execute'), 'authenticated cannot forge fenced transitions');
select ok(not has_function_privilege('anon','public.refresh_publication_credentials(uuid,text,bigint,public.target_status,jsonb,text,uuid,bigint,jsonb,text,boolean,boolean,uuid,text)','execute'), 'anon cannot refresh fenced credentials');

create temp table claimed_review as select * from public.claim_meta_review_targets('review-due',
 '70000000-0000-4000-8000-000000000002','review-security@example.test',(select generation from security_generation),100,300);
select is((select count(*) from claimed_review), 1::bigint, 'review-aware due claiming selects current-generation work');
select is((select count(*) from public.claim_due_targets('owner-due',100,300) where authorization_context='meta_review'), 0::bigint, 'owner due claiming never selects reviewer work');
reset role;

set local "request.jwt.claims" = '{"sub":"70000000-0000-4000-8000-000000000001","email":"owner-security@example.test"}';
set local role authenticated;
select is((select count(*) from public.connected_accounts where owner_id='70000000-0000-4000-8000-000000000001'), 1::bigint, 'installation owner has positive-control RLS access');
select is((select count(*) from public.connected_accounts where owner_id='70000000-0000-4000-8000-000000000002'), 0::bigint, 'installation owner cannot read reviewer workspace');
reset role;
set local "request.jwt.claims" = '{"sub":"70000000-0000-4000-8000-000000000002","email":"review-security@example.test"}';
set local role authenticated;
select is((select count(*) from public.connected_accounts), 0::bigint, 'reviewer has no direct connected-account RLS access');
select is((select count(*) from public.media_assets), 0::bigint, 'reviewer has no direct media RLS access');
reset role;
set local "request.jwt.claims" = '{"sub":"70000000-0000-4000-8000-000000000003","email":"unrelated-security@example.test"}';
set local role authenticated;
select is((select count(*) from public.posts), 0::bigint, 'unrelated user has no post RLS access');
reset role;

set local role service_role;
select is((select limit_bytes from public.meta_review_storage_usage('70000000-0000-4000-8000-000000000002')), 483183820::bigint, 'reviewer allocation is smaller and bounded');
select throws_ok($$select public.reserve_meta_review_media('70000000-0000-4000-8000-000000000002','too-large.jpg','image/jpeg',483183821,null,null,null)$$,
 'P0001', 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: reservation unavailable', 'reviewer allocation cannot be exceeded');
update public.media_assets set size_bytes=1700000000 where id='70000000-0000-4000-8000-000000000021';
select throws_ok($$select public.reserve_meta_review_media('70000000-0000-4000-8000-000000000002','combined.jpg','image/jpeg',300000000,null,null,null)$$,
 'P0001', 'UPLOADTHING_ACTIVE_MEDIA_LIMIT: reservation unavailable', 'combined usage cannot exceed the application ceiling');
update public.media_assets set deleted_at=now() where id='70000000-0000-4000-8000-000000000021';
select ok(public.reserve_meta_review_media('70000000-0000-4000-8000-000000000002','released.jpg','image/jpeg',1000,null,null,null) is not null,
 'confirmed deletion releases shared capacity');
select is((select count(*) from public.media_assets where owner_id='70000000-0000-4000-8000-000000000001' and deleted_at is null), 0::bigint,
 'reviewer reservation does not expose or modify owner media');

insert into public.oauth_states(owner_id,platform,state_hash,redirect_uri,expires_at,authorization_context,
 authorization_generation,browser_binding_hash,auth_session_id,initiating_email)
values('70000000-0000-4000-8000-000000000002','instagram','review-state','https://callback.test',now()+interval '5 minutes',
 'meta_review',(select generation from security_generation),repeat('a',64),'70000000-0000-4000-8000-000000000099','review-security@example.test');
select ok(public.set_meta_review_authorization('70000000-0000-4000-8000-000000000002','review-security@example.test',false,now()+interval '1 hour') is not null,
 'explicit revocation rotates the authorization generation');
select ok((select consumed_at is not null from public.oauth_states where state_hash='review-state'), 'revocation consumes outstanding OAuth state');
select is((select status::text from public.post_targets where id='70000000-0000-4000-8000-000000000042'), 'blocked_authorization', 'revocation invalidates queued reviewer work');
select is(public.current_meta_review_authorization('70000000-0000-4000-8000-000000000002','review-security@example.test'), null::jsonb, 'revoked authorization cannot resolve');
update security_generation set generation=public.set_meta_review_authorization('70000000-0000-4000-8000-000000000002','review-security@example.test',true,now()+interval '1 hour');
reset role;
update auth.users set banned_until=now()+interval '1 hour' where id='70000000-0000-4000-8000-000000000002';
select is((select enabled from public.meta_review_authorization), false, 'Auth ban authoritatively revokes the grant');
select is(public.current_meta_review_authorization('70000000-0000-4000-8000-000000000002','review-security@example.test'), null::jsonb, 'banned reviewer cannot resolve authorization');
update auth.users set banned_until=null where id='70000000-0000-4000-8000-000000000002';
update security_generation set generation=public.set_meta_review_authorization('70000000-0000-4000-8000-000000000002','review-security@example.test',true,now()+interval '1 hour');
update auth.users set email='renamed-security@example.test' where id='70000000-0000-4000-8000-000000000002';
select is((select enabled from public.meta_review_authorization), false, 'Auth email change authoritatively revokes the grant');
select ok((select generation from security_generation) is distinct from (select generation from public.meta_review_authorization), 'old generations cannot revive after identity change');

select ok((public.verify_meta_review_schema()->>'ready')::boolean, 'schema preflight includes the remediation RPC boundaries');
reset role;

select ok(not has_function_privilege('anon','public.begin_account_disconnect(uuid,uuid)','execute'), 'anon cannot begin disconnect');
select ok(not has_function_privilege('authenticated','public.mark_account_disconnect_revocation_started(uuid,uuid,uuid)','execute'), 'authenticated cannot mark disconnect revocation');
select ok(not has_function_privilege('anon','public.record_account_disconnect_revocation(uuid,uuid,uuid,text)','execute'), 'anon cannot record disconnect outcome');
select ok(not has_function_privilege('authenticated','public.complete_account_disconnect(uuid,uuid,uuid,boolean)','execute'), 'authenticated cannot complete disconnect cleanup');
select ok(not has_function_privilege('anon','app_private.reserve_workspace_media(uuid,text,text,text,bigint,integer,integer,numeric)','execute'), 'shared quota helper remains private');

select * from finish();
rollback;
