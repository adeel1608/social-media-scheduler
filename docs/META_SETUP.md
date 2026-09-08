# Instagram / Meta setup

Verified 2026-09-03 against the official Instagram Platform overview,
Instagram Login content-publishing guide, insights references and permissions.
Meta changes dashboard navigation; use the official **Instagram API with
Instagram Login** onboarding shown for the app, not Instagram Basic Display or
an unofficial product.

## Account and app

1. Convert/connect the installation owner's account as an Instagram
   professional account (Business or Creator). Story availability has
   additional account/configuration restrictions; use a Business account when
   Stories are required and confirm the current capability in Meta.
2. In [Meta for Developers](https://developers.facebook.com/apps/),
   create/select the owner's app and add the Instagram product/configuration
   that explicitly says **Instagram API with Instagram Login** and supports
   content publishing.
3. In its API setup/login settings, add the exact OAuth redirect URI:

   `https://YOUR_WORKER_HOST/api/oauth/instagram/callback`

4. Add the final web origin, Privacy Policy, Terms of Use and Data Deletion
   URLs. Customize the templates before submitting them.
5. Request only:

   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_insights`

   If deliberately choosing the Facebook Login configuration instead, follow
   that configuration's current official permission set and adapt the code;
   do not mix the two login models.

6. In App Review > Permissions and Features (or the current equivalent),
   request the access level needed for real accounts. Complete business
   verification if Meta asks.
7. Set `META_APP_REVIEW_APPROVED=true` only after Meta confirms the required
   access. The temporary reviewer mode below does not make that claim and must
   never change this flag.

## Temporary Meta reviewer workspace

Postline's hosted application is private and single-owner. A narrowly scoped,
temporary reviewer workspace allows a Meta reviewer to sign in without being
given the installation owner's credentials. It is disabled in source by
default and is not public registration.

The server verifies the email, Supabase Auth UUID and a `password`
authentication-method claim from the reviewer's already-verified JWT. A magic
link for that user therefore cannot enter the reviewer workspace. Reviewer
operations are limited to the reviewer's own Instagram OAuth
state, account, UploadThing media, post targets and analytics. Existing owner
RLS remains unchanged and gives the reviewer no direct table access. The
Worker uses service-only RPCs with explicit reviewer ownership checks. A
durable, expiring authorization generation follows the OAuth state, connected
account, post, media, publishing target and queue message. Current Supabase Auth
status is rechecked at each privileged boundary; a ban, deletion, email change,
password disablement, grant rotation or unavailable Auth service fails closed.
TikTok,
YouTube, setup, settings, export, installation deletion, manual retry and
manual ambiguity resolution are denied.

Reviewer publication is a separate exception, not a provider-approval or live
publishing bypass. It is valid only when all of these remain true at execution
time:

- `META_REVIEW_MODE=true` on the Worker;
- the target owner is the exact configured `META_REVIEWER_USER_ID`;
- the connected account and every post/media record belong to that user;
- the account, OAuth state and target carry the `meta_review` context; and
- their authorization generation equals the current expiring server-side grant; and
- the platform is Instagram.

`META_APP_REVIEW_APPROVED`, `LIVE_TEST_CONFIRM`,
`TIKTOK_CONTENT_POSTING_AUDITED` and `YOUTUBE_API_AUDIT_APPROVED` remain
`false`. If the review mode or identity no longer matches, queue processing
blocks before token decryption or any provider request.

### Create the temporary user

Do this manually immediately before the review window:

1. Apply and verify the additive migrations from
   `202609060001_meta_review_access.sql` through
   `202609070009_analytics_generation_isolation.sql` in a reviewed release. These add
   browser/session-bound OAuth, current reviewer authorization, publication
   fencing, service-only disconnect recovery, shared upload quota controls and
   generation-isolated analytics reads.
   Do not deploy
   code that depends on it until `verify_meta_review_schema` returns
   `{"ready":true}` through the service-role production preflight.
2. In Supabase Dashboard > Authentication > Providers > Email, confirm that
   **Allow new users to sign up** is off. Keep anonymous sign-in off.
3. In Supabase Dashboard > Authentication > Users, manually create exactly one
   temporary user with the placeholder identity
   `META_REVIEWER_EMAIL_PLACEHOLDER`. Mark the address confirmed using the
   dashboard's administrative flow; do not create an application signup path.
4. Generate a unique password of at least 16 characters in a password manager.
   Set it only in Supabase Auth. Do not put it in source, `.env`, GitHub,
   Cloudflare, a command argument, a screenshot, a recording or documentation.
5. Copy the user's UUID as `META_REVIEWER_USER_ID_PLACEHOLDER`. Confirm the
   review email is lower-case and is not the owner email.
6. Confirm Supabase CAPTCHA protection already uses Cloudflare Turnstile. Both
   owner OTP and reviewer password authentication send a Turnstile token to
   Supabase.
7. In a reviewed Supabase SQL Editor session, call the service-only
   `set_meta_review_authorization` function with the exact UUID, normalized
   email, `true`, and a short expiry covering only the review window. Never
   record the password or returned generation. This operator action is never
   performed by a Worker request or deployment.

### Configure and enable safely

OAuth start creates a high-entropy, one-use `Secure`, `HttpOnly`, `SameSite=Lax`
browser cookie whose hash is bound to the verified Supabase session, identity,
context, generation, redirect URI and expiry. A missing/different-browser cookie
or stale session fails before Meta token exchange. Instagram does not claim
PKCE; its encrypted verifier field is retained as a cross-provider storage
detail. A database uniqueness constraint prevents the same Instagram remote
account from being silently linked into conflicting workspaces.

The checked-in Worker and Pages defaults must stay `false`. Prepare a reviewed
temporary release that changes only the Worker `META_REVIEW_MODE` variable to
`true`. Configure the two identity values through Wrangler's hidden,
versioned prompts so the resulting Worker version remains inactive:

```bash
corepack pnpm --dir apps/worker exec wrangler versions secret put META_REVIEWER_EMAIL
corepack pnpm --dir apps/worker exec wrangler versions secret put META_REVIEWER_USER_ID
```

Enter only the placeholder-replaced values in those interactive prompts. Do
not pass either value on the command line. Set the protected GitHub production
environment variable `META_REVIEW_MODE=true`; the Pages workflow maps it to
the public visibility flag `VITE_META_REVIEW_MODE`. This browser flag only
reveals the reviewer login form—the Worker identity gate is authoritative.

Before any deployment:

```bash
corepack pnpm check
corepack pnpm test:e2e
corepack pnpm audit --audit-level high
corepack pnpm --dir apps/worker exec wrangler deploy --dry-run
```

Inspect the inactive Worker version's binding **names**, confirm the three Meta
review settings are present, confirm the four approval/live flags remain
`false`, and run the migration preflight. Deploy the database migration first,
then require `verify_meta_review_schema` to report ready before deploying the
reviewed Worker version, then Pages. Migration `202609070009` revokes direct
service-role analytics reads so an old Worker fails closed, while the preflight
prevents a new Worker from reaching an old schema. Do not split queue traffic
across versions with different reviewer gates.

In a clean/incognito browser, open:

`https://YOUR_WEB_HOST/login?review=meta`

Verify the owner magic-link form is still available at `/login`, incorrect and
unlisted reviewer users receive the same generic error, TikTok/YouTube and
owner-only pages are absent, and guessed owner resource IDs are rejected. The
reviewer must connect their own Instagram professional account through the
official OAuth screen. Never pre-connect the owner's Instagram account for the
reviewer.

Provide the temporary email and password only through Meta's private App
Review credential fields. Never place them in a screencast, repository, issue,
chat or public review note.

## Three review screencasts

Record these against the real reviewer workspace; mocks and owner credentials
are not acceptable:

1. **`instagram_business_basic`** — start at the reviewer login URL, sign in,
   open Connected Accounts, complete Instagram Login with the reviewer's own
   professional account, and show the real username/account type and connected
   state in Postline. Do not expose the password, OAuth code/state or tokens.
2. **`instagram_business_content_publish`** — upload permitted test media,
   create one Instagram-only post, show its selected reviewer account and
   schedule/publish state, then show the real provider result/status. Do not
   imply that the app is already approved and do not use owner content.
3. **`instagram_business_manage_insights`** — open Analytics for the
   reviewer-owned published media, request a sync, and show real returned
   Instagram insights. Unsupported metrics must remain unavailable rather than
   appearing as zero.

Actual provider publication is a human-controlled review action. This code
change and its automated tests do not perform it.

## Disable and clean up after review

Perform cleanup in this order so no queue job can outlive the temporary gate:

1. Stop creating review content. In the reviewer UI, cancel every reviewer
   target that has not started provider publication. For an in-progress or
   ambiguous target, inspect Instagram and resolve the real provider outcome;
   never blindly retry it.
2. From the reviewer's Connected Accounts page, disconnect the reviewer-owned
   Instagram account. Complete any displayed durable local-cleanup
   confirmation. Verify the provider token is revoked/disconnected without
   touching the owner's account.
3. Delete reviewer test media only after all targets using it are published or
   cancelled and UploadThing confirms deletion. If any file cannot be deleted
   through Postline, identify and remove that reviewer-owned test file in the
   installation's UploadThing dashboard before deleting its database record.
4. Set the Worker `META_REVIEW_MODE` and protected GitHub environment variable
   `META_REVIEW_MODE` back to `false`. Remove the Worker bindings
   `META_REVIEWER_EMAIL` and `META_REVIEWER_USER_ID` in a reviewed inactive
   version. Do not change any approval/live flag.

   ```bash
   corepack pnpm --dir apps/worker exec wrangler versions secret delete META_REVIEWER_EMAIL
   corepack pnpm --dir apps/worker exec wrangler versions secret delete META_REVIEWER_USER_ID
   ```

   Inspect the generated version and its binding names before deploying it.

5. Deploy the disabled Worker version and a Pages build with
   `VITE_META_REVIEW_MODE=false`. Verify `/login?review=meta` shows unavailable,
   a retained reviewer JWT receives 403 from `/api/session`, and queued
   reviewer work blocks before a provider request.
6. After every reviewer UploadThing object is confirmed deleted and every
   reviewer account is disconnected, replace the UUID placeholder and run this
   guarded transaction in Supabase SQL Editor. It refuses to operate on the
   installation owner or on live/ambiguous work:

   ```sql
   do $$
   declare
     reviewer_id uuid := 'META_REVIEWER_USER_ID_PLACEHOLDER';
   begin
     if exists (
       select 1 from public.installation_settings where owner_id = reviewer_id
     ) then
       raise exception 'Refusing to delete the installation owner';
     end if;
     if exists (
       select 1 from public.connected_accounts
       where owner_id = reviewer_id and connection_status = 'connected'
     ) then
       raise exception 'Disconnect reviewer accounts first';
     end if;
     if exists (
       select 1 from public.post_targets
       where owner_id = reviewer_id
         and status in ('queued', 'publishing', 'processing', 'needs_review')
     ) then
       raise exception 'Resolve reviewer publication state first';
     end if;
     if exists (
       select 1 from public.media_assets
       where owner_id = reviewer_id
         and storage_provider = 'uploadthing'
         and deleted_at is null
     ) then
       raise exception 'Delete reviewer UploadThing objects first';
     end if;

     delete from public.posts where owner_id = reviewer_id;
     delete from public.connected_accounts where owner_id = reviewer_id;
     delete from public.media_assets where owner_id = reviewer_id;
     delete from public.oauth_states where owner_id = reviewer_id;
     delete from public.account_disconnect_transactions
       where owner_id = reviewer_id;
     delete from public.rate_limit_buckets where owner_id = reviewer_id;
     delete from public.audit_log where owner_id = reviewer_id;
   end;
   $$;
   ```

   The post/account foreign keys remove their dependent reviewer analytics,
   attempts, targets, post-media links, disconnect transactions and email
   events. Verify zero reviewer-owned rows remain. Never substitute the owner
   UUID.

7. Delete or permanently disable the temporary Supabase Auth reviewer user.
   Confirm public signup is still disabled. Re-run the disabled-access checks
   from an incognito browser.

If rollback is needed before review completes, perform steps 1–5 first. The
additive schema columns and service-only functions can remain dormant; remove
them only with a later reviewed forward migration, never by editing or
replaying an applied migration.

## Publishing and analytics implementation

Postline creates child containers, writes lease- and version-fenced durable
markers immediately before each provider write, polls asynchronous processing and calls
`/{ig-user-id}/media_publish`. Its signed Worker endpoint supplies short-lived
HTTPS media backed by a validated UploadThing file. Feed-image alt text is sent
only where the official guide supports it; it is not claimed for Reels or
Stories.

The adapter requests media insights through official `/insights` endpoints
with `instagram_business_manage_insights` and stores raw names plus normalized
values. Meta varies/deprecates metrics by media type and version, so the UI
keeps unsupported values unavailable.

Owner and reviewer uploads share the repository's existing 1,932,735,283-byte
application safety ceiling. Reviewer reservations additionally have a
483,183,820-byte allocation. Both paths take the same database transaction
lock; quota failures do not disclose owner media or usage.

Official sources:
[overview](https://developers.facebook.com/docs/instagram-platform/overview),
[Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login),
[content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing),
[insights](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/insights),
[permissions](https://developers.facebook.com/docs/permissions/),
[Supabase password sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithpassword),
[Supabase JWT claims](https://supabase.com/docs/guides/auth/jwt-fields),
and [Supabase CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha).
