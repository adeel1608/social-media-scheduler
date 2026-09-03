# ADR 0001: Free-tier-first execution stack

- Status: accepted
- Date: 2026-09-03

## Decision

Use React/Vite, Cloudflare Workers/Cron/Queues/R2, Supabase Postgres/Auth, Resend HTTPS, and a pnpm TypeScript monorepo.

## Rationale

The components match the requested independent-instance model and separate durable records, short backend execution, queued provider work, private object storage, email authentication, and failure notification. Long provider uploads are persisted as resumable sessions and advanced through separate safe queue jobs instead of assuming one Worker invocation can upload an entire file.

## Consequences

Deployers configure several services and must monitor changing free-plan allowances. There is no central Postline account, credential broker, or quota. GitHub Actions provides CI/deployment only; it is never the production scheduler.
