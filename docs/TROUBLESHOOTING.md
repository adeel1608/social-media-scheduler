# Troubleshooting

## Setup doctor reports missing

Copy `.env.example` to a local untracked `.env` for the doctor, or provide the variables in the shell. Placeholder values count as missing. Worker production secrets must be added separately with Wrangler; a local `.env` does not deploy them.

## Magic link works but access is denied

Confirm the verified Supabase user email, `OWNER_EMAIL`, and lower-case `installation_settings.owner_email` match exactly. Confirm that table’s `owner_id` is the authenticated user UUID. Unknown users are intentionally denied, and Postline does not create them during magic-link login.

## OAuth callback says invalid/expired state

Start the connection again in the same environment. State expires after ten minutes and is consumed once. Confirm the provider callback exactly matches the Worker URI—including scheme, host, path and trailing slash behavior. Do not reuse an old callback URL.

## Target is `blocked_authorization`

Check account connection, token expiry and platform approval. A past-due target becomes eligible automatically after a valid approved connection is restored. `LIVE_TEST_CONFIRM=false` also deliberately prevents a real provider request.

## TikTok public visibility blocked

This is expected until the Content Posting API audit is complete and `TIKTOK_CONTENT_POSTING_AUDITED=true`. Do not work around it with `SELF_ONLY`, browser automation or manual posting. Confirm creator info currently returns `PUBLIC_TO_EVERYONE`.

## YouTube public visibility blocked

Complete the API project upload audit referenced by `videos.insert`, then set the audit flag. OAuth verification and upload audit are related setup gates but are not proof of each other.

## Provider could not fetch media

Confirm the short-lived signed Worker HTTPS URL is still valid and redirect-free. TikTok PULL_FROM_URL/photo also requires domain or URL-prefix ownership. Meta must reach the URL while creating its container. The Worker validates the app-specific UploadThing hostname and streams the response; it does not accept a destination URL from the caller.

## Upload initiation or callback failed

Confirm `WORKER_PUBLIC_URL` is the exact deployed HTTPS Worker origin and `UPLOADTHING_TOKEN` is a valid v7 token stored as a Worker secret. The browser must send the current Supabase owner JWT. Do not protect the callback with generic owner middleware: the public provider callback is authenticated by UploadThing's SDK signature verification. A failed callback leaves a bounded reservation so another concurrent upload cannot bypass quota.

## Chunk upload reports a range error

Do not start a new publish. Inspect the encrypted upload-session state and provider-reported accepted range, then continue the existing session. TikTok chunks must follow current 5–64 MB/final-part rules and upload sequentially. YouTube resumable status uses an empty probe with `Content-Range: bytes */TOTAL` per its guide.

## `needs_review`

The publication request may have reached the provider but could not be reconciled. Open the provider first. Do not retry until you establish whether content exists. Unlike `failed`, this state intentionally has no immediate retry button.

## Duplicate failure email

Inspect `email_events.deduplication_key`, its unique constraint and the attempt number. One email is expected per failed/ambiguous attempt; a deliberate later manual retry can generate a new failure email because it is a new attempt.

## Storage keeps growing

Failed, ambiguous, incomplete, and pending items retain media by design. Resolve them before deletion. Confirm successful targets have `published_at`, every selected target is published, the seven-day retention has passed, and cron is running. The storage panel separates active provider bytes from reservations. An expired reservation remains counted until UploadThing deletion/absence is confirmed; repeated failures record a deletion error for later safe retry.

## Cron or queue does not run

Cloudflare Cron is UTC. Confirm `* * * * *` under Worker → Settings → Triggers and the correct queue bindings. Inspect sanitized Worker logs. The consumer is configured with zero automatic retries, so application failures appear in Postline instead of redelivery loops.

## Database migration failure

Run `corepack pnpm db:validate`, inspect `corepack pnpm supabase db push --dry-run`, and confirm migrations are applied in filename order. Use a new forward migration to repair deployed schema; do not edit history after deployment.

## No analytics value

“Not provided” is not zero. Verify the analytics scope, provider processing delay, media type/report combination and data-retention rules. Revenue/content-owner YouTube reports are outside the default least-privilege scopes.
