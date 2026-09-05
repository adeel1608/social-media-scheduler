# Security

## Model

Each deployment has one owner. Supabase authenticates with a one-time magic link, the Worker compares the verified email to `OWNER_EMAIL`, and RLS requires the JWT user ID plus matching installation owner email. The client requests magic links with `shouldCreateUser: false`, and the checked-in Supabase Auth configuration disables direct global/email signup and anonymous users. Hosted installations must apply the same dashboard setting after creating the owner, because client controls alone do not protect the direct Auth API.

## Secrets and tokens

- Browser code receives only the Supabase anon key and public service URLs.
- Service role, `UPLOADTHING_TOKEN`, OAuth client secrets, Resend key, and encryption/signing keys are Worker secrets.
- Access/refresh tokens use Web Crypto AES-256-GCM with a unique 96-bit nonce. Ciphertext, nonce and key version use separate fields.
- OAuth state is random, hashed at rest, expires after ten minutes and is consumed once. PKCE S256 is used where supported; its verifier is encrypted at rest.
- Production configuration requires each provider callback to be the exact path on `WORKER_PUBLIC_URL`; redirects cannot contain credentials, query strings, or fragments.
- Provider upload-session URLs are encrypted. Attempts/logs/email pass through structural redaction and never include tokens or signed media URLs.

Generate a 32-byte base64 encryption key locally. Key versions are canonical
lowercase identifiers such as `v1` or `v2`. The current key uses
`TOKEN_ENCRYPTION_KEY`; a historical `v1` key uses the secret binding
`TOKEN_ENCRYPTION_KEY_V1` (and so on). Decryption resolves only the version
stored with the ciphertext and fails closed if that exact key is unavailable.
To rotate, first deploy code and the historical binding able to read both
versions, re-encrypt every account and active upload session in a controlled
transaction/batch, verify, and only then remove the old binding. Do not merely
change `TOKEN_ENCRYPTION_KEY_VERSION` or silently try the current key.

Existing ciphertext predates additional authenticated data (AAD). Adding AAD
would make existing records unreadable unless it is introduced through an
explicit ciphertext-format version and controlled re-encryption migration; it
is therefore deferred rather than being applied incompatibly during a key
resolver change.

## API controls

- Zod validates incoming posts, pagination and platform metadata.
- Every `/api/*` endpoint except provider OAuth callbacks and the UploadThing file-route endpoint requires generic owner middleware. Upload initiation authenticates the owner inside UploadThing route middleware; UploadThing callbacks are public so the provider can reach them, but the official SDK verifies their HMAC signature before completion logic runs.
- State-changing database RPCs enforce owner identity/RLS again.
- Sensitive route rate limiting is backed by `rate_limit_buckets`; deployments should also add Cloudflare WAF/rate-limit rules to OAuth and upload endpoints.
- Email OTP requests are spaced by at least 60 seconds in the local Auth configuration. Hosted deployments must retain that minimum, review Supabase Auth rate limits, and add CAPTCHA when appropriate for their public threat model.
- Security headers deny framing, MIME sniffing, sensitive browser capabilities, and unexpected origins. The production build generates a Pages CSP whose connection sources are limited to the configured Worker and Supabase origins plus UploadThing's documented regional ingest hosts.
- UploadThing provider URLs are validated against the app-specific official hostname (plus the documented legacy host) and exact provider file key before storage or fetch. Redirects, credentials, unexpected ports, arbitrary hosts and malformed ranges are rejected. Signed delivery URLs resolve a media UUID server-side and cannot proxy arbitrary destinations.

## Publishing safety

- No provider password is accepted. No scraping, Selenium, browser automation, quota bypass or unofficial publishing endpoint exists.
- Production configuration fails closed at the HTTP, scheduled, and queue entry points. Except for the diagnostic `/health` response, an incomplete production Worker returns 503 before authentication, callbacks, delivery, or application routes run. Mock adapters exist only as injected test fetches; there is no production mock fallback.
- Real publishing requires `LIVE_TEST_CONFIRM=true`.
- TikTok and YouTube public requests remain invalid while the provider audit flag is false. Postline never silently changes requested public content to private.
- The consumer writes `publish_request_sent_at` before sending. Instagram additionally writes a durable phase marker immediately before every non-idempotent child, carousel-parent, and final publish request. Read-only polling cannot perform provider writes. A duplicate job cannot automatically resend an unresolved phase; ambiguity becomes `needs_review` and is never blindly republished. Durable provider/validation outcomes are acknowledged, while infrastructure failures receive five bounded Queue retries before the dead-letter queue.

## Data handling

UploadThing Free source files are public-readable through opaque, hard-to-guess URLs; signed Postline delivery URLs do not make those underlying files private. When all selected targets succeed, media is retained seven days and deleted only after cleanup rechecks database state. Failed, ambiguous, incomplete and pending media is kept until it is safe for owner action. Deletion changes quota accounting only after UploadThing confirms deletion or absence. Metadata, audit records and analytics remain until deletion.

Disconnect requests use an owner/account-bound, expiring server-side transaction. A write-ahead transition allows only one provider revocation request; response loss, refresh, browser restart, and repeated DELETE cannot replay that provider write. Local credential destruction and completion are one database transaction, and the browser rehydrates pending cleanup without receiving credentials. Unknown provider outcomes remain explicitly uncertain; Postline does not reinterpret an error as “already revoked” without documented provider semantics. Installation deletion does not delete already-published provider content; this is stated in the public deletion template.

## Dependency and source security

CI runs formatting, linting, type checking, unit/integration tests, builds, migration validation, a high-severity dependency audit, secret-pattern scan and CodeQL. Enable GitHub secret scanning and dependency alerts on the public repository. Protect the default branch by requiring the CI `verify`, `e2e`, and `codeql` checks, and protect the manual `production` environment separately.

## Reporting a vulnerability

Do not open a public issue containing a vulnerability or secret. Use GitHub private vulnerability reporting after it is enabled under Security → Advisories. Revoke any exposed credential immediately, rotate it at the provider, invalidate sessions, and review `audit_log` plus provider activity.

This document is technical guidance, not legal advice.
