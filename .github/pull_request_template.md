## Architecture

- React/Vite owner dashboard talks to a Cloudflare Worker with Supabase magic-link authentication.
- Supabase Postgres stores one post plus independent Instagram, TikTok, and YouTube targets.
- UTC cron claims due work transactionally; Cloudflare Queue delivers target IDs to lease-aware consumers.
- Owner-authorized direct uploads use UploadThing; signed Worker delivery resolves media server-side and validates every upstream URL/range.

## Features

- Multi-platform composer with per-target media and metadata overrides.
- Cursor-paginated, virtualized queue; calendar, history, manual retry, and ambiguous-result resolution.
- Official Instagram, TikTok, and YouTube OAuth, publishing, status, thumbnail, and analytics adapters.
- Historical analytics snapshots with explicit unavailable metrics and per-post detail.
- Owner-only authorization, encrypted refreshable tokens, audit logging, rate limits, retention, and failure-only email.
- Explicit local demo mode that cannot publish or masquerade as live data.

## Verification

- `corepack pnpm check`
- `corepack pnpm test:e2e`
- `corepack pnpm audit --audit-level high`
- Cloudflare Worker dry-run build
- Desktop visual QA at 1440 x 900

## Deployment

Deployment is intentionally manual and credential-gated. Follow `HUMAN_SETUP.md` and `DEPLOYMENT.md`; keep `LIVE_TEST_CONFIRM=false` until a controlled owner-authorized live test.

## Outstanding human actions

- Provision and migrate the owner's Supabase project.
- Create an UploadThing app/token and provision Cloudflare Worker, Queue, cron, custom domains, and secrets. R2 is not used.
- Verify a Resend sender.
- Register Meta, TikTok, and Google applications and complete their access reviews or audits.
- Customize and review the legal templates.
- Run one controlled live verification only after provider dashboards confirm the requested permissions.

No production credentials were available during implementation. Provider behavior is mock-tested; no real social post or hosted deployment is claimed.
