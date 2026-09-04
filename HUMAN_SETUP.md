# Human setup checklist

The repository completes everything that can be built and mock-tested without account credentials. These actions require the installation owner. Do them in order; never paste secrets into chat, GitHub issues, or source files.

## 1. Create the repository and verify identity

Choose the GitHub account and repository that will own your installation. Set
the expected values for your fork or clone, then require every identity check
to pass before any push:

```bash
EXPECTED_GITHUB_LOGIN="YOUR_GITHUB_LOGIN"
EXPECTED_GITHUB_REPOSITORY="$EXPECTED_GITHUB_LOGIN/YOUR_REPOSITORY"
gh auth login
test "$(gh api user --jq .login)" = "$EXPECTED_GITHUB_LOGIN"
git remote get-url origin
test "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" = "$EXPECTED_GITHUB_REPOSITORY"
```

Inspect the remote URL and correct it to your intended repository if necessary.
Do not continue when either exact comparison fails, and do not push to any
other repository. The upstream maintainer repository is
`adeel1608/social-media-scheduler`; it is an example, not the required identity
for cloned installations.

## 2. Provision Supabase

Follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md). Record the project URL and public anon key for the browser. Store the service-role key only as a Worker secret. Apply migrations, create the one owner user, and insert `installation_settings` with the exact lower-case `OWNER_EMAIL`.

## 3. Provision UploadThing

Follow [docs/UPLOADTHING_SETUP.md](docs/UPLOADTHING_SETUP.md). Create your own application on UploadThing's free 2 GB plan. Free files are public-readable through opaque URLs, and Postline enforces a 1.8 GiB active/outstanding cap. Enter the v7 token only into the hidden Wrangler prompt; never expose it in chat, screenshots, commits, issues, logs, or browser variables.

## 4. Provision Cloudflare

Follow [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md). Inspect first, then create only missing free production/dead-letter queues, add Worker secrets, deploy, and confirm the UTC one-minute cron. R2 is not used and must not be enabled for this setup.

## 5. Configure email delivery

Follow [docs/EMAIL_SETUP.md](docs/EMAIL_SETUP.md). Supabase Auth SMTP sends
owner login links; the Worker's separate Resend configuration sends only
deduplicated failure/ambiguous-result notifications. Clone owners provide their
own credentials for both paths. A Resend verified domain is preferred. Its test
sender is limited to the Resend account owner's address and is only an
owner-only evaluation option, not a general production sender. No success email
is sent.

## 6. Register provider applications

Complete in this order so each provider receives stable policy and deletion URLs:

1. Configure `VITE_OPERATOR_NAME` and `VITE_PUBLIC_CONTACT_EMAIL`, then deploy the UI so `/privacy`, `/terms`, and `/data-deletion` are public.
2. [Instagram / Meta](docs/META_SETUP.md): create the app, add exact callback, request content publishing and insights permissions, connect a professional account, and complete access/review requirements.
3. [TikTok](docs/TIKTOK_SETUP.md): add Login Kit and Content Posting API, verify the media-delivery domain/prefix, request `video.publish`, and complete the audit. Public posts must stay blocked until it passes.
4. [YouTube](docs/YOUTUBE_SETUP.md): enable Data and Analytics APIs, configure consent and web client, then complete verification/audit. Unverified-project uploads stay private, so requested public uploads must remain blocked.

## 7. Configure values without exposing them

Generate a token-encryption key locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy the output directly into a secure secret manager or a hidden Wrangler
prompt. On an existing Worker, use the versioned secret command so the new
version remains undeployed until you explicitly deploy it. Add the UploadThing
token separately without displaying either value:

```bash
corepack pnpm --dir apps/worker exec wrangler versions secret put TOKEN_ENCRYPTION_KEY
corepack pnpm --dir apps/worker exec wrangler versions secret put UPLOADTHING_TOKEN
```

`wrangler secret put` is different: it creates a Worker version and deploys it
immediately. Do not use it as a non-deploying preparation step. Versioned
secret commands require the Worker to exist; follow the inert-bootstrap process
in [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md) for a new Worker. Do not
save either secret in shell history on a shared machine.

Run the doctor:

```bash
corepack pnpm setup-doctor
```

It reports presence/format/connectivity/approval/readiness without displaying values. Resolve every missing/invalid line. An approval flag may become `true` only after the provider dashboard confirms it.

## 8. Controlled live verification

Keep `LIVE_TEST_CONFIRM=false` through development and mock testing. After reviewing provider policies and intentionally selecting a controlled owner test:

1. Confirm the platform app is in the permitted mode and the owner account is authorized.
2. Use content that is safe to publish.
3. For TikTok/YouTube, do not request public visibility until their dashboard confirms the required audit.
4. Set `LIVE_TEST_CONFIRM=true` as a Worker secret/variable.
5. Publish one target, confirm its provider ID/status and Postline attempt record, confirm analytics later, then test a deliberate pre-request validation failure.
6. Set the flag back to `false` if further setup work is required.

Never describe mocks or a successful OAuth callback as a live publishing test.

## 9. Production checks

Run `corepack pnpm check`, `corepack pnpm test:e2e`, `corepack pnpm audit --audit-level high`, and verify `/health`. Confirm backups, the UploadThing 1.8 GiB application cap and 2 GB provider allowance, cron, queue `max_retries=0`, sender configuration and its documented scope, owner allowlist, UploadThing/provider callback URIs, token expiry, audit flags, and log redaction.

Keep direct Auth signup disabled in the hosted Supabase dashboard, require at
least 60 seconds between email requests, and review Auth rate limits/CAPTCHA.
The checked-in local Supabase defaults enforce the same signup and email-spacing
baseline.
