# ADR 0001: Free-tier-first execution stack

- Status: accepted
- Date: 2026-09-03

## Decision

Use React/Vite, Cloudflare Workers/Cron/Queues, UploadThing Free storage, Supabase Postgres/Auth, Resend HTTPS, and a pnpm TypeScript monorepo.

## Rationale

The components match the requested independent-instance model and separate durable records, short backend execution, queued provider work, direct media transfer, email authentication, and failure notification. Cloudflare R2 is intentionally not required. Long social-provider uploads are persisted as resumable sessions and advanced through separate safe queue jobs instead of assuming one Worker invocation can upload an entire file.

## Consequences

Deployers configure several services and must monitor changing free-plan allowances. UploadThing Free storage is finite and public-readable through opaque URLs; Postline enforces a concurrency-safe 1.8 GiB cap below its documented 2 GB allowance. There is no central Postline account or credential broker. GitHub Actions provides CI/deployment only; it is never the production scheduler.
