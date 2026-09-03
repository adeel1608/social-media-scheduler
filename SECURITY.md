# Security

## Model

Each deployment has one owner. Supabase authenticates with a one-time magic link, the Worker compares the verified email to `OWNER_EMAIL`, and RLS requires the JWT user ID plus matching installation owner email. The client requests magic links with `shouldCreateUser: false`, so unknown email addresses cannot self-register through Postline.

## Secrets and tokens

- Browser code receives only the Supabase anon key and public service URLs.
- Service role, OAuth client secrets, R2 keys, Resend key, and encryption key are Worker secrets.
- Access/refresh tokens use Web Crypto AES-256-GCM with a unique 96-bit nonce. Ciphertext, nonce and key version use separate fields.
- OAuth state is random, hashed at rest, expires after ten minutes and is consumed once. PKCE S256 is used where supported; its verifier is encrypted at rest.
- Provider upload-session URLs are encrypted. Attempts/logs/email pass through structural redaction and never include tokens or signed media URLs.

Generate a 32-byte base64 encryption key locally. To rotate, deploy code able to read old/new versions, re-encrypt every account and active upload session in a controlled transaction/batch, verify, then remove the old key. Do not merely change `TOKEN_ENCRYPTION_KEY_VERSION`.

## API controls

- Zod validates incoming posts, pagination and platform metadata.
- Every `/api/*` endpoint except provider OAuth callbacks requires owner middleware. Callbacks rely on short-lived one-use state tied to the owner.
- State-changing database RPCs enforce owner identity/RLS again.
- Sensitive route rate limiting is backed by `rate_limit_buckets`; deployments should also add Cloudflare WAF/rate-limit rules to OAuth and upload endpoints.
- Security headers deny framing, MIME sniffing, sensitive browser capabilities and unexpected origins. Set CSP connect sources to actual production hosts.
- R2 keys are random and private. Upload and delivery URLs are short-lived; configure bucket CORS only for the exact web origin.

## Publishing safety

- No provider password is accepted. No scraping, Selenium, browser automation, quota bypass or unofficial publishing endpoint exists.
- Production configuration fails closed. Mock adapters exist only as injected test fetches; there is no production mock fallback.
- Real publishing requires `LIVE_TEST_CONFIRM=true`.
- TikTok and YouTube public requests remain invalid while the provider audit flag is false. Postline never silently changes requested public content to private.
- The consumer writes `publish_request_sent_at` before sending. A duplicate job cannot automatically resend. API failure is recorded and Queue delivery is acknowledged. Ambiguity becomes `needs_review`.

## Data handling

Source media is private. When all targets succeed, it is retained seven days and then deleted only after the cleanup job rechecks database state. Failed/ambiguous media is kept until owner action. Metadata, remote URLs, audit records and analytics remain until deletion.

Disconnect requests provider revocation where supported before encrypted credentials are destroyed. Installation deletion does not delete already-published provider content; this is stated in the public deletion template.

## Dependency and source security

CI runs formatting, linting, type checking, unit/integration tests, builds, migration validation, a high-severity dependency audit, secret-pattern scan and CodeQL. Enable GitHub secret scanning and dependency alerts on the public repository.

## Reporting a vulnerability

Do not open a public issue containing a vulnerability or secret. Use GitHub private vulnerability reporting after it is enabled under Security → Advisories. Revoke any exposed credential immediately, rotate it at the provider, invalidate sessions, and review `audit_log` plus provider activity.

This document is technical guidance, not legal advice.
