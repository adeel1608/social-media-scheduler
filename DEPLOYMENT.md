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
has `max_retries = 5` plus the configured dead-letter queue. Durable platform
outcomes are acknowledged. Only safely retryable infrastructure failures use
Queue redelivery; a recorded or ambiguous provider request must not create a
duplicate publish attempt.

For encryption-key rotation, keep the current key in
`TOKEN_ENCRYPTION_KEY` and add each still-needed historical version as a Worker
secret named `TOKEN_ENCRYPTION_KEY_<VERSION>`, for example
`TOKEN_ENCRYPTION_KEY_V1`. Version identifiers must match
`^[a-z][a-z0-9]{0,31}$`. Upload the binding in an inactive version, confirm the
binding name without reading its value, and deploy it before any ciphertext is
rewritten to a newer version.

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
corepack pnpm --dir apps/worker exec wrangler pages deploy apps/web/dist --cwd ../.. --project-name YOUR_PAGES_PROJECT
```

Configure SPA fallback, HTTPS, and the final custom domain. Update Supabase URL configuration and provider callback URIs if the canonical URL changes.

## Verification

During an inert-bootstrap setup, the following read-only check verifies all
public policy routes without following redirects and confirms that the Worker
still returns the explicitly expected unavailable status. It never reads
secrets or mutates infrastructure:

```bash
POSTLINE_PUBLIC_APP_URL=https://YOUR_WEB_HOST \
POSTLINE_PUBLIC_WORKER_URL=https://YOUR_WORKER_HOST \
POSTLINE_EXPECTED_WORKER_STATUS=503 \
corepack pnpm production:inspect
```

Use environment-variable syntax appropriate to the local shell. After an
intentional Worker activation, choose the expected status that matches the
reviewed endpoint instead of mechanically retaining `503`.

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

`.github/workflows/deploy.yml` is manual (`workflow_dispatch`), requires the
operator to type `DEPLOY`, and uses the protected `production` environment. Set
the non-secret `CLOUDFLARE_PAGES_PROJECT`, `CLOUDFLARE_WORKER_NAME`, `APP_URL`,
`API_URL`, `SUPABASE_URL`, `OPERATOR_NAME`, and `PUBLIC_CONTACT_EMAIL`
repository/environment variables.
Set only the Cloudflare deployment credentials and browser-safe Supabase anon
key in the workflow's secret store. The preflight rejects missing, malformed,
or placeholder values without printing them. GitHub Actions is never the
production scheduler, and merges do not run this deployment workflow.

Create and protect the GitHub `production` environment before adding its
configuration: restrict deployment branches to the default branch and require
the intended human reviewers where the repository plan supports that rule. The
workflow independently rejects a run whose source ref is not the default
branch.
