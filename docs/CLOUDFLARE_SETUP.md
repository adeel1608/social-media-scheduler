# Cloudflare setup

Verified against current Workers, Cron, Queues, and Wrangler documentation on 2026-09-04. Cron Triggers run in UTC. Postline does not require R2; do not enable it or add billing for this deployment.

1. Authenticate with `corepack pnpm --dir apps/worker exec wrangler login`, then run `corepack pnpm --dir apps/worker exec wrangler whoami`. Confirm the exact intended account.
2. List existing queues. Create `social-scheduler-publish` and `social-scheduler-dead-letter` only if absent and only while Queues Free is active.
3. Confirm whether the Worker exists. `wrangler versions upload` and the versioned secret commands require an existing Worker. For a brand-new Worker, first deploy a reviewed minimal inert bootstrap that serves only an unavailable response and contains no production logic.
4. On the existing Worker, add secrets through the hidden `corepack pnpm --dir apps/worker exec wrangler versions secret put NAME` prompt. This creates an undeployed version. The unversioned `wrangler secret put NAME` instead creates a version and deploys it immediately; never treat it as non-deploying preparation. The dashboard equivalent also requires careful review of whether its final action deploys.
5. Add `UPLOADTHING_TOKEN` using the exact hidden-prompt command in [UPLOADTHING_SETUP.md](UPLOADTHING_SETUP.md). Never place it in Wrangler configuration, a browser variable, logs, screenshots, chat, commits, or issues.
6. Configure a stable Worker HTTPS custom domain. Set `WORKER_PUBLIC_URL` to that origin and use the same origin in the web `VITE_API_URL`. UploadThing callbacks arrive at `/api/uploadthing`.
7. Run the Worker dry-run, then use `corepack pnpm --dir apps/worker exec wrangler versions upload` to create a reviewed inactive code version. This command does not deploy, but the Worker must already exist. Deploy that specific version only after all configuration is real and the release is explicitly approved.
8. Wrangler uses the committed queue bindings and `crons = ["* * * * *"]`. After the deliberate production deployment, verify Worker → Settings → Triggers → Cron Triggers and queue producer/consumer bindings.
9. Confirm the queue consumer has `max_retries = 5` and `dead_letter_queue = "social-scheduler-dead-letter"`. Durable provider/validation outcomes are recorded and acknowledged. Only thrown infrastructure failures are redelivered; after the bounded retries Cloudflare moves the message to the DLQ.
10. For TikTok pull-based photo publication, verify the Worker `/delivery/` URL prefix or domain in TikTok. It must remain HTTPS and redirect-free while TikTok fetches it.
11. Verify `/health`, sanitized logs, and analytics. Logs must contain request IDs and safe messages only. Keep `[observability] redact_query_string = true` so OAuth codes, state, signatures, and other URL credentials are omitted from invocation logs.
12. For the optional manual GitHub deployment workflow, configure the
    `CLOUDFLARE_PAGES_PROJECT` and `CLOUDFLARE_WORKER_NAME` variables with the
    clone owner's exact resource names. The workflow resolves its pinned Wrangler from the Worker
    package but runs Pages from the repository root so it does not consume the
    Worker's `wrangler.toml`. It validates configuration before either deploy
    step and remains gated by the `production` environment plus typed
    confirmation.

The cleanup cron rechecks every selected target before deleting successful media after seven days. It retains failed, ambiguous, incomplete, and pending media. Expired UploadThing reservations are released only after the official deletion API confirms deletion or absence.

Official sources: [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), and [Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/).
