# Human setup checklist

The repository completes everything that can be built and mock-tested without account credentials. These actions require the installation owner. Do them in order; never paste secrets into chat, GitHub issues, or source files.

## 1. Create the repository and verify identity

This project targets `adeel1608/social-media-scheduler`. Before any push:

```bash
gh auth login
gh api user --jq .login
# must print exactly: adeel1608
git remote get-url origin
# must be exactly: https://github.com/adeel1608/social-media-scheduler.git
gh repo view adeel1608/social-media-scheduler
```

If the local URL differs, use `git remote set-url origin https://github.com/adeel1608/social-media-scheduler.git`. Do not continue if the authenticated login differs. Do not touch any other repository.

## 2. Provision Supabase

Follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md). Record the project URL and public anon key for the browser. Store the service-role key only as a Worker secret. Apply migrations, create the one owner user, and insert `installation_settings` with the exact lower-case `OWNER_EMAIL`.

## 3. Provision UploadThing

Follow [docs/UPLOADTHING_SETUP.md](docs/UPLOADTHING_SETUP.md). Create your own application on UploadThing's free 2 GB plan. Free files are public-readable through opaque URLs, and Postline enforces a 1.8 GiB active/outstanding cap. Enter the v7 token only into the hidden Wrangler prompt; never expose it in chat, screenshots, commits, issues, logs, or browser variables.

## 4. Provision Cloudflare

Follow [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md). Inspect first, then create only missing free production/dead-letter queues, add Worker secrets, deploy, and confirm the UTC one-minute cron. R2 is not used and must not be enabled for this setup.

## 5. Configure failure email

Follow [docs/EMAIL_SETUP.md](docs/EMAIL_SETUP.md). Verify a domain and create a restricted Resend API key. Set `NOTIFICATION_EMAIL` and a `RESEND_FROM` address on the verified domain. No success email is sent.

## 6. Register provider applications

Complete in this order so each provider receives stable policy and deletion URLs:

1. Deploy the UI so `/privacy`, `/terms`, and `/data-deletion` are public and customize their template content.
2. [Instagram / Meta](docs/META_SETUP.md): create the app, add exact callback, request content publishing and insights permissions, connect a professional account, and complete access/review requirements.
3. [TikTok](docs/TIKTOK_SETUP.md): add Login Kit and Content Posting API, verify the media-delivery domain/prefix, request `video.publish`, and complete the audit. Public posts must stay blocked until it passes.
4. [YouTube](docs/YOUTUBE_SETUP.md): enable Data and Analytics APIs, configure consent and web client, then complete verification/audit. Unverified-project uploads stay private, so requested public uploads must remain blocked.

## 7. Configure values without exposing them

Generate a token-encryption key locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy the output directly into a secure secret manager or the hidden `wrangler secret put TOKEN_ENCRYPTION_KEY` prompt. Add the UploadThing token separately without displaying it:

```bash
corepack pnpm --dir apps/worker exec wrangler secret put UPLOADTHING_TOKEN
```

Do not save either secret in shell history on a shared machine.

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

Run `corepack pnpm check`, `corepack pnpm test:e2e`, `corepack pnpm audit --audit-level high`, and verify `/health`. Confirm backups, the UploadThing 1.8 GiB application cap and 2 GB provider allowance, cron, queue `max_retries=0`, sender domain, owner allowlist, UploadThing/provider callback URIs, token expiry, audit flags, and log redaction.
