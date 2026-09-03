# UploadThing setup

Postline uses UploadThing v7 for direct browser uploads, storage, and provider deletion. Each person cloning this repository must create their own UploadThing application and secret; credentials are never shared by Postline.

## Plan and privacy limits

- Use only the UploadThing Free “2GB App” plan unless you independently choose and approve a different plan.
- The application reserves at most 1.8 GiB of active/outstanding media, leaving headroom below the finite 2 GB provider allowance.
- Every provider file and incomplete reservation counts until deletion or absence is confirmed. Concurrent reservations are serialized in PostgreSQL.
- Free-plan files are public-readable to anyone who learns their opaque, hard-to-guess provider URL. Postline's signed Worker delivery URLs restrict normal platform access but do not convert the underlying file into private storage.
- Media is deleted seven days after every selected target succeeds. Failed, ambiguous, incomplete, and pending target media is retained.

Do not upload sensitive material that cannot safely have public-readable URL exposure.

## Create and configure the app

1. Sign in to UploadThing and create one application for this Postline installation on the free plan.
2. Copy its v7 token directly from the UploadThing dashboard into the hidden Wrangler prompt. Do not paste it into chat, screenshots, commits, issue comments, shell command arguments, `.env.example`, or any `VITE_` variable:

   ```bash
   corepack pnpm --dir apps/worker exec wrangler secret put UPLOADTHING_TOKEN
   ```

3. Set the non-secret `WORKER_PUBLIC_URL` to the final HTTPS Worker origin. The Worker supplies `https://YOUR_WORKER_HOST/api/uploadthing` as the callback URL.
4. Deploy only after all production secrets are real. Upload a harmless file while `LIVE_TEST_CONFIRM=false`, wait for server-confirmed completion, inspect the storage-usage panel, then delete it and confirm usage falls.

The SDK's signed callback verification is handled by the public `/api/uploadthing` file-route endpoint. Upload initiation on the same endpoint still requires the existing Supabase owner bearer token. Do not place generic owner middleware in front of callbacks.

Official references: [UploadThing authentication and callback security](https://docs.uploadthing.com/concepts/auth-security), [file routes](https://docs.uploadthing.com/file-routes), [client uploads](https://docs.uploadthing.com/api-reference/client), [UTApi deletion](https://docs.uploadthing.com/api-reference/ut-api), and [working with files](https://docs.uploadthing.com/working-with-files).
