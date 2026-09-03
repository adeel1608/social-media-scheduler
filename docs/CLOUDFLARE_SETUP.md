# Cloudflare setup

Verified against current Workers, Cron, Queues, R2 and Wrangler documentation on 2026-09-03. Cron Triggers run in UTC.

1. Authenticate with `pnpm --dir apps/worker exec wrangler login`, then `wrangler whoami`. Confirm the exact intended account.
2. Create `social-scheduler-media`, `social-scheduler-publish`, and `social-scheduler-dead-letter` with commands in [DEPLOYMENT.md](../DEPLOYMENT.md).
3. Apply `apps/worker/r2-cors.json` after replacing the origin placeholder with the exact HTTPS web origin. Keep the bucket private; do not attach an `r2.dev` public URL or listing.
4. Create an R2 API token scoped only to this bucket for S3-compatible signed direct uploads. Set account ID, access-key ID and secret as Worker secrets.
5. Route the controlled media hostname (for example `media.example.com`) to this Worker and set `R2_PUBLIC_DELIVERY_HOST` to its HTTPS origin. The Worker exposes only opaque, HMAC-signed `/delivery/:key` requests for at most one hour; the bucket remains private and has no listing. If TikTok photo/PULL_FROM_URL is used, verify that exact domain or URL prefix in TikTok. It must serve HTTPS without redirects for the entire provider fetch.
6. From `apps/worker`, add secrets using `wrangler secret put NAME`. Cloudflare dashboard equivalent: Workers & Pages → Worker → Settings → Variables and Secrets → Add → Secret → Deploy.
7. Deploy. Wrangler uses the committed bindings and `crons = ["* * * * *"]`. Verify Worker → Settings → Triggers → Cron Triggers and Queue producer/consumer bindings.
8. Confirm queue consumer `max_retries = 0`. Provider errors are durable application results; infrastructure must not automatically redeliver them.
9. Add a custom API domain, then set `APP_URL`, web `VITE_API_URL`, CORS origin and provider callbacks consistently.
10. Verify `/health`, logs and analytics. Logs must contain request IDs and safe messages only.

Do not add an unconditional R2 age-deletion lifecycle rule: failed media must be retained. The application cleanup job rechecks target status before deleting. It also aborts multipart uploads left incomplete for 24 hours.

Official sources: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/), [R2 bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
