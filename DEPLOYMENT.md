# Deployment

This path deploys an independent Postline instance. It does not create a shared service.

## Prerequisites

- Node.js 24 and pnpm 11.25 through Corepack
- An UploadThing application on the free 2 GB plan
- Supabase CLI linked to the intended project
- Wrangler authenticated to the intended Cloudflare account
- Stable HTTPS web and Worker/API URLs
- Completed steps in [HUMAN_SETUP.md](HUMAN_SETUP.md)

## Validate source

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test:e2e
corepack pnpm audit --audit-level high
```

## Database

Inspect the linked target, then apply ordered migrations:

```bash
corepack pnpm supabase projects list
corepack pnpm supabase migration list
corepack pnpm supabase db push --dry-run
corepack pnpm supabase db push
corepack pnpm supabase migration list
```

Create the owner user and installation row as described in [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md). Never use the service-role key in the browser. Migration `202609030003_uploadthing_storage.sql` adds UploadThing metadata plus atomic reservation, completion, and usage RPCs. It preserves legacy storage rows for forward compatibility; the current application does not fetch or delete those legacy objects.

## UploadThing

Complete [docs/UPLOADTHING_SETUP.md](docs/UPLOADTHING_SETUP.md). Enter the v7 token directly into Wrangler's hidden prompt:

```bash
corepack pnpm --dir apps/worker exec wrangler versions secret put UPLOADTHING_TOKEN
```

This versioned command requires an existing Worker and creates an undeployed
version. Never place the token in a `VITE_` variable, command argument, chat,
screenshot, commit, issue, or build log. Set `WORKER_PUBLIC_URL` to the final
Worker HTTPS origin so UploadThing can reach `/api/uploadthing` callbacks.

## Cloudflare Worker resources and secrets

Inspect resources before creating anything. R2 is neither needed nor authorized:

```bash
corepack pnpm --dir apps/worker exec wrangler whoami
corepack pnpm --dir apps/worker exec wrangler queues list
corepack pnpm --dir apps/worker exec wrangler queues create social-scheduler-publish
corepack pnpm --dir apps/worker exec wrangler queues create social-scheduler-dead-letter
```

Run the two create commands only when their exact queues are absent and
Cloudflare confirms Queues Free. Before using version commands, confirm the
Worker already exists. For a first Worker, make one reviewed, minimal inert
bootstrap deployment that returns an unavailable response and contains no
production logic. Do not use the real Postline entry point for that bootstrap.

For an existing Worker, enter each sensitive value through the hidden prompt:

```bash
corepack pnpm --dir apps/worker exec wrangler versions secret put NAME
```

This creates an undeployed version. By contrast, `wrangler secret put NAME`
creates a version and immediately deploys it, so it must not be described or
used as non-deploying preparation. Keep review flags false until their provider
dashboards confirm approval. Configure `WORKER_PUBLIC_URL` and `APP_URL` as
exact production origins.

Build without publishing and inspect bindings:

```bash
corepack pnpm build:verify
corepack pnpm --dir apps/worker exec wrangler deploy --dry-run
```

`wrangler versions upload` uploads real code without deploying it, but it also
requires the Worker to exist. After the inert bootstrap and secret preparation,
create an inactive version for review:

```bash
corepack pnpm --dir apps/worker exec wrangler versions upload
```

Deploy the reviewed version only when every real required secret is present and
the operator has intentionally approved the release. A normal `wrangler deploy`
also creates and immediately deploys a new version. Wrangler applies the UTC
cron and queue bindings in `wrangler.toml`; verify the cron and that the consumer
has `max_retries = 0`. Platform failures are durable application results and
must not automatically create a duplicate publish attempt.

## Web application

Set only these public build-time values in the web hosting project:

- `VITE_APP_URL=https://YOUR_WEB_HOST`
- `VITE_API_URL=https://YOUR_WORKER_HOST`
- `VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co`
- `VITE_SUPABASE_ANON_KEY=...` (public anon key only)
- `VITE_DEMO_MODE=false`
- `VITE_OPERATOR_NAME=YOUR_PUBLIC_OPERATOR_NAME`
- `VITE_PUBLIC_CONTACT_EMAIL=YOUR_PUBLIC_CONTACT_EMAIL`

Build and deploy to a static host. Example with Cloudflare Pages:

```bash
corepack pnpm --filter @scheduler/web build
corepack pnpm exec wrangler pages deploy apps/web/dist --project-name postline
```

Configure SPA fallback, HTTPS, and the final custom domain. Update Supabase URL configuration and provider callback URIs if the canonical URL changes.

## Verification

```bash
curl -fsS https://YOUR_WORKER_HOST/health
```

Expected production state is `status: ok` and `configured: true`. Test owner magic link, verify another email receives 403, upload harmless media, confirm the media is selectable only after callback completion, and inspect quota/audit records. UploadThing Free files are public-readable through opaque URLs; a signed Postline delivery URL does not make the underlying file private.

Do not enable `LIVE_TEST_CONFIRM` merely to make `/health` green. No social publication is authorized until provider approval and an intentional controlled test.

## Safe migrations and rollback

1. Back up the Supabase database.
2. Review SQL and run the remote dry run against the exact linked project.
3. Deploy additive database changes before code that consumes them.
4. Deploy the Worker, then web UI.
5. Roll back application code by deploying a prior build; repair database schema/data only with a reviewed forward migration.

## CI deployment

`.github/workflows/deploy.yml` is manual (`workflow_dispatch`) and requires protected environment secrets. GitHub Actions is never the production scheduler.
