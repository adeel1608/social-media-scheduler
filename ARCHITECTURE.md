# Architecture

Postline is a TypeScript/pnpm monorepo for a single-owner installation.

## Components

| Path                  | Responsibility                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | React/Vite authenticated desktop interface, direct upload client, virtualized queue, previews, analytics                    |
| `apps/worker`         | Hono HTTP API, owner authorization, OAuth callbacks, R2 signing, cron, queue consumer, analytics sync, cleanup              |
| `packages/shared`     | Zod contracts, scheduling state machine, AES-GCM, OAuth/PKCE, media/timezone validation, analytics normalization, redaction |
| `packages/platforms`  | Typed official-API adapter contract and Instagram, TikTok, YouTube implementations                                          |
| `packages/database`   | Generated-style database types and opaque pagination cursors                                                                |
| `supabase/migrations` | Reproducible schema, RLS, indexes, atomic claim and manual-retry functions                                                  |

## Request and trust boundaries

The browser receives only the Supabase public/anon key. It authenticates by magic link and sends the short-lived user JWT to the Worker. The Worker validates that JWT with Supabase Auth, compares its email to `OWNER_EMAIL`, and owner-scoped PostgREST requests are evaluated again by RLS. Service-role credentials, platform client secrets, token encryption keys, R2 signing keys, refresh tokens, and Resend keys exist only in Worker secrets.

Connected-account tokens are encrypted with Web Crypto AES-256-GCM. The ciphertext and 96-bit nonce use separate columns, with algorithm/key-version metadata to support rotation. OAuth state records store a SHA-256 state hash, expire within 10 minutes, are single-use, and store PKCE verifier ciphertext separately.

## Scheduling and publication

1. Browser validates content and requests the transaction-backed `create_scheduled_post` RPC.
2. The database writes a post plus one independent `post_targets` row per platform with a stable versioned idempotency key.
3. UTC cron calls `claim_due_targets`. PostgreSQL first blocks targets without a valid approved connection, reactivates past-due targets after authorization is restored, then uses `FOR UPDATE SKIP LOCKED` and a lease to claim due rows atomically.
4. The Worker enqueues only `{ targetId, mode, requestedAt }`; credentials never enter Queue messages.
5. The consumer loads and decrypts credentials server-side. The first provider request sets `publish_request_sent_at` before sending so duplicate deliveries cannot silently issue another publish request.
6. Each target persists its own selected media IDs, so a YouTube thumbnail is not accidentally sent to Instagram/TikTok. R2 ranges stream to chunk/resumable provider sessions. Session URLs are encrypted in `platform_upload_state`; sanitized attempts never include them.
7. Processing polls may continue safely. A definite API failure is recorded and acknowledged with no automatic retry. A network-ambiguous publication becomes `needs_review` unless a provider status handle can reconcile it.
8. A unique `email_events.deduplication_key` prevents duplicate failure email.

## State model

`draft → scheduled | blocked_authorization → queued → publishing → processing → published`

Definite errors transition to `failed`; ambiguous results transition to `needs_review`; owner cancellation is allowed only before publication begins. Only `failed` supports explicit manual retry. Manual retry creates a new idempotency-key version. `needs_review` must be resolved after checking the provider.

## Media lifecycle

Browser media is validated before direct upload. R2 objects are private, randomly named, and never listed publicly. Files at least 100 MB use multipart upload. Provider delivery uses an opaque `/delivery/:key` Worker route with a short-lived HMAC and no-store response; the bucket itself has no public URL. TikTok also requires ownership verification for the exact custom domain or URL prefix used by pull-based media.

When every target is published, application logic schedules source retention for seven days. Cron checks database state again before deletion. Any `failed` or `needs_review` target prevents automatic deletion. Stale multipart uploads are aborted after 24 hours.

## Time

The user selects `Australia/Melbourne`; UTC is persisted. Luxon/IANA conversion rejects spring-forward nonexistent times and autumn ambiguous times instead of guessing. Cron always operates in UTC.

## Analytics

Adapters preserve raw provider metric names and map only defensible equivalents. Missing values are `{available:false,value:null}`, never zero. Engagement rate is `(likes + comments + shares + saves) / views × 100`, using only available interaction metrics and returning unavailable when views are missing/zero. Snapshots retain history and the provider date range.

## Scaling

There is no application-level queue count. API pages are capped to 100 records per request, use opaque cursor/keyset pagination, and the UI renders a small window regardless of total count. Due claims process bounded batches; additional cron runs continue the backlog. Provider and infrastructure quotas remain external constraints.
