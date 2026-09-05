# Architecture

Postline is a TypeScript/pnpm monorepo for a single-owner installation.

## Components

| Path                  | Responsibility                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | React/Vite authenticated desktop interface, direct upload client, virtualized queue, previews, analytics                      |
| `apps/worker`         | Hono HTTP API, owner authorization, verified UploadThing callbacks, signed delivery, cron, queue consumer, analytics, cleanup |
| `packages/shared`     | Zod contracts, scheduling state machine, AES-GCM, OAuth/PKCE, media/timezone validation, analytics normalization, redaction   |
| `packages/platforms`  | Typed official-API adapter contract and Instagram, TikTok, YouTube implementations                                            |
| `packages/database`   | Generated-style database types and opaque pagination cursors                                                                  |
| `supabase/migrations` | Reproducible schema, RLS, indexes, atomic claim and manual-retry functions                                                    |

## Request and trust boundaries

The browser receives only the Supabase public/anon key. It authenticates by magic link and sends the short-lived user JWT to the Worker. The Worker validates that JWT with Supabase Auth, compares its email to `OWNER_EMAIL`, and owner-scoped PostgREST requests are evaluated again by RLS. Service-role credentials, the UploadThing token, platform client secrets, delivery-signing keys, refresh tokens, and Resend keys exist only in Worker secrets.

Connected-account tokens are encrypted with Web Crypto AES-256-GCM. The ciphertext and 96-bit nonce use separate columns, with algorithm/key-version metadata to support rotation. OAuth state records store a SHA-256 state hash, expire within 10 minutes, are single-use, and store PKCE verifier ciphertext separately.

## Scheduling and publication

1. Browser validates content and requests the transaction-backed `create_scheduled_post` RPC.
2. The database writes a post plus one independent `post_targets` row per platform with a stable versioned idempotency key.
3. UTC cron calls `claim_due_targets`. PostgreSQL first blocks targets without a valid approved connection, reactivates past-due targets after authorization is restored, then uses `FOR UPDATE SKIP LOCKED` and a lease to claim due rows atomically.
4. The Worker enqueues only `{ targetId, mode, requestedAt }`; credentials never enter Queue messages.
5. The consumer loads and decrypts credentials server-side. The first provider request sets `publish_request_sent_at` before sending so duplicate deliveries cannot silently issue another publish request.
6. Each target persists its own selected media IDs, so a YouTube thumbnail is not accidentally sent to Instagram/TikTok. Validated UploadThing ranges stream to chunk/resumable provider sessions. Session URLs are encrypted in `platform_upload_state`; sanitized attempts never include them.
7. Processing polls may continue safely. A definite API failure is recorded and acknowledged with no automatic provider retry. A network-ambiguous publication becomes `needs_review` unless a provider status handle can reconcile it. Infrastructure-only Queue failures use bounded delivery retries and a dead-letter queue. Cron leases and redispatches stale `publishing`/`processing` targets; an existing upload session or status handle is continued, while a target with a recorded provider request is never blindly resubmitted.
8. A unique `email_events.deduplication_key` prevents duplicate failure email.

## State model

`draft → scheduled | blocked_authorization → queued → publishing → processing → published`

Definite errors transition to `failed`; ambiguous results transition to `needs_review`; owner cancellation is allowed only before publication begins. Only `failed` supports explicit manual retry. Manual retry creates a new idempotency-key version. `needs_review` must be resolved after checking the provider.

## Media lifecycle

After browser inspection, the owner JWT authorizes an UploadThing file-route request. A database RPC locks the installation row and atomically reserves the requested bytes before the browser uploads directly to UploadThing. Only an SDK-verified callback can finalize the reservation, and media is selectable only after that transaction succeeds. Every non-deleted upload/reservation counts toward a hard 1.8 GiB limit; expired reservations are released only after deletion is confirmed or the provider reports the file absent.

UploadThing Free files are public-readable through opaque URLs. The server validates the exact configured app delivery hostname and file key at persistence and every fetch boundary. Social providers normally receive an HMAC-signed `/delivery/:media-id` URL; that endpoint resolves the completed owner media record server-side, rejects redirects, supports one validated byte range, and streams only safe response headers. It is an access-control layer for normal application use, not a claim that the underlying free-plan object is private. TikTok may require ownership verification for the Worker domain or URL prefix.

When every selected target is published, application logic schedules source retention for seven days. Cron checks every target again and records the official UploadThing deletion result before excluding bytes from quota. Any failed, ambiguous, incomplete, or pending target prevents automatic deletion. Incomplete reservations expire after 24 hours, but keep consuming quota until cleanup confirms deletion or absence.

## Time

The user selects `Australia/Melbourne`; UTC is persisted. Luxon/IANA conversion rejects spring-forward nonexistent times and autumn ambiguous times instead of guessing. Cron always operates in UTC.

## Analytics

Adapters preserve raw provider metric names and map only defensible equivalents. Missing values are `{available:false,value:null}`, never zero. Engagement rate is `(likes + comments + shares + saves) / views × 100`, using only available interaction metrics and returning unavailable when views are missing/zero. Snapshots retain history and the provider date range.

## Scaling

There is no application-level queue count. API pages are capped to 100 records per request, use opaque cursor/keyset pagination, and the UI renders a small window regardless of total count. Due claims process bounded batches; additional cron runs continue the backlog. Provider and infrastructure quotas remain external constraints.
