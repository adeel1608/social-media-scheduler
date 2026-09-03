# Cloudflare setup

Verified against current Workers, Cron, Queues, and Wrangler documentation on 2026-09-03. Cron Triggers run in UTC. Postline does not require R2; do not enable it or add billing for this deployment.

1. Authenticate with `corepack pnpm --dir apps/worker exec wrangler login`, then run `corepack pnpm --dir apps/worker exec wrangler whoami`. Confirm the exact intended account.
2. List existing queues. Create `social-scheduler-publish` and `social-scheduler-dead-letter` only if absent and only while Queues Free is active.
3. Add secrets with `corepack pnpm --dir apps/worker exec wrangler secret put NAME`. The dashboard equivalent is Workers & Pages → Worker → Settings → Variables and Secrets → Add → Secret → Deploy.
4. Add `UPLOADTHING_TOKEN` using the exact hidden-prompt command in [UPLOADTHING_SETUP.md](UPLOADTHING_SETUP.md). Never place it in Wrangler configuration, a browser variable, logs, screenshots, chat, commits, or issues.
5. Configure a stable Worker HTTPS custom domain. Set `WORKER_PUBLIC_URL` to that origin and use the same origin in the web `VITE_API_URL`. UploadThing callbacks arrive at `/api/uploadthing`.
6. Deploy. Wrangler uses the committed queue bindings and `crons = ["* * * * *"]`. Verify Worker → Settings → Triggers → Cron Triggers and queue producer/consumer bindings.
7. Confirm the queue consumer has `max_retries = 0`. Provider failures are recorded and acknowledged instead of automatically redelivered.
8. For TikTok pull-based photo publication, verify the Worker `/delivery/` URL prefix or domain in TikTok. It must remain HTTPS and redirect-free while TikTok fetches it.
9. Verify `/health`, sanitized logs, and analytics. Logs must contain request IDs and safe messages only.

The cleanup cron rechecks every selected target before deleting successful media after seven days. It retains failed, ambiguous, incomplete, and pending media. Expired UploadThing reservations are released only after the official deletion API confirms deletion or absence.

Official sources: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
