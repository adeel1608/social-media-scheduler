# Deployment

This path deploys an independent instance. It does not create a shared Postline service.

## Prerequisites

- Node.js 24 and pnpm 11.25 through Corepack
- Supabase CLI authenticated to the intended project
- Wrangler authenticated to the intended Cloudflare account
- A stable HTTPS web URL and Worker/API URL
- Completed steps in [HUMAN_SETUP.md](HUMAN_SETUP.md)

## Validate source

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm audit --audit-level high
```

## Database

Link only the intended project, inspect the target, then apply ordered migrations:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push --dry-run
supabase db push
```

Create the owner user and installation row as described in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md). Do not use the service-role key in the browser.

## Worker resources and secrets

From `apps/worker`, create the named resources once:

```bash
pnpm exec wrangler whoami
pnpm exec wrangler r2 bucket create social-scheduler-media
pnpm exec wrangler queues create social-scheduler-publish
pnpm exec wrangler queues create social-scheduler-dead-letter
pnpm exec wrangler r2 bucket cors set social-scheduler-media --file r2-cors.json
```

Add every sensitive value from `.env.example` with `wrangler secret put NAME`. Non-secret production variables can be placed in an environment-specific Wrangler section. Keep review flags false until dashboard confirmation.

Route the exact HTTPS hostname configured as `R2_PUBLIC_DELIVERY_HOST` to this Worker (custom domain or route). Keep R2 private. TikTok must verify this exact hostname or `/delivery/` URL prefix before pull-based photo publishing.

Build without publishing and inspect bindings:

```bash
pnpm build
pnpm exec wrangler deploy --dry-run
```

Deploy the Worker:

```bash
pnpm exec wrangler deploy
```

Wrangler applies the `* * * * *` UTC Cron Trigger and queue bindings from `wrangler.toml`. In Cloudflare, verify Worker → Settings → Triggers → Cron Triggers and Settings → Bindings. Verify the consumer has zero automatic retries; the application itself records and acknowledges platform failures.

## Web application

Set these build-time values in the web hosting project:

- `VITE_APP_URL=https://YOUR_WEB_HOST`
- `VITE_API_URL=https://YOUR_WORKER_HOST`
- `VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co`
- `VITE_SUPABASE_ANON_KEY=…` (public anon key only)
- `VITE_DEMO_MODE=false`

Build and deploy to a static host. Example with Cloudflare Pages:

```bash
pnpm --filter @scheduler/web build
pnpm exec wrangler pages deploy apps/web/dist --project-name postline
```

Configure SPA fallback to `index.html`, HTTPS, and the final custom domain. Update Supabase URL Configuration and all provider callback URIs if the canonical URL changes.

## Verification

```bash
curl -fsS https://YOUR_WORKER_HOST/health
```

Expected production state is `status: ok`, `configured: true`. Approval flags may still be false and will visibly block that platform. Test owner magic link; verify a different email receives a 403; upload a harmless media file; schedule without enabling live publication; inspect UTC storage and audit log.

Do not enable `LIVE_TEST_CONFIRM` merely to make `/health` green. It is a separate intentional safety switch.

## Safe migrations and rollback

1. Back up the Supabase database.
2. Review migration SQL and `supabase db push --dry-run`.
3. Deploy additive database changes before code that consumes them.
4. Deploy the Worker, then web UI.
5. For rollback, deploy the previous Worker/web commit. Avoid destructive down migrations. Correct database data/schema with a reviewed forward migration.

## CI deployment

`.github/workflows/deploy.yml` is manual (`workflow_dispatch`) and requires protected environment secrets. GitHub Actions is never used for post scheduling.
