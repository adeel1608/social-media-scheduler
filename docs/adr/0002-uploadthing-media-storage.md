# ADR 0002: UploadThing media storage

- Status: accepted
- Date: 2026-09-03

## Context

The original design required Cloudflare R2, but the target account does not have R2 enabled and this deployment must not activate billing. The owner has an UploadThing application on its free “2GB App” plan. Free-plan files use public-read access through opaque URLs; private-file ACLs are a paid-plan capability.

Adding exact `uploadthing@7.7.4` introduces `msgpackr-extract@3.0.4` through `@effect/platform → msgpackr`. Its install command selects optional native prebuilds for faster MessagePack string extraction. `msgpackr` declares it optional, and Cloudflare Workers use the JavaScript path rather than that Node native addon.

## Decision

- Use exact UploadThing 7.7.4 in the Worker and web app.
- Keep `msgpackr-extract` installation scripts explicitly disabled with `allowBuilds: false`; do not broadly approve dependency scripts.
- Override transitive `effect` to 3.20.0, which remains within `@effect/platform`'s peer range and includes the upstream AsyncLocalStorage security fix.
- Authenticate upload initiation with the existing Supabase owner JWT, reserve bytes atomically in PostgreSQL, and rely on the official UploadThing route handler to verify callback signatures.
- Cap all active/outstanding UploadThing media at 1.8 GiB. A reservation counts until provider deletion or absence is confirmed.
- Store the provider file key and validated canonical HTTPS URL. Accept only the configured `<APP_ID>.ufs.sh` host or documented legacy `utfs.io` host with an exact expected identifier, and reject redirects at each fetch boundary.
- Give social platforms short-lived HMAC-signed Worker URLs that resolve a media UUID server-side and stream validated UploadThing content. This does not make the underlying public-read file private.
- Use the official `UTApi.deleteFiles` operation and record deletion state. Delete successful media after seven days; retain failed, ambiguous, incomplete, and pending media.

## Consequences

Large files upload directly from the browser and social-provider resumable uploads continue to stream ranges without full buffering. The installation requires its own UploadThing app and server-only `UPLOADTHING_TOKEN`. Storage is finite, public-readable by opaque URL, and cannot be described as private. Legacy database records remain identifiable for forward compatibility, but current runtime storage operations are UploadThing-only.

Official references: [UploadThing pricing](https://uploadthing.com/), [regions and ACL](https://docs.uploadthing.com/concepts/regions-acl), [callback security](https://docs.uploadthing.com/concepts/auth-security), [file routes](https://docs.uploadthing.com/file-routes), and [UTApi deletion](https://docs.uploadthing.com/api-reference/ut-api).
