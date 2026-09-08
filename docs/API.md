# Worker API

All `/api/*` routes except OAuth provider callbacks and UploadThing's signed
callback request require a valid Supabase bearer session. The installation
owner must match `OWNER_EMAIL`. A default-disabled Meta reviewer must match
both configured email and JWT UUID and receives only the documented
Instagram-review allowlist. UploadThing upload initiation authenticates the
same workspace principal inside file-route middleware; the official SDK
verifies callback signatures. Owner operations are authorized again by RLS;
reviewer operations use service-only RPCs with explicit reviewer ownership.
JSON error bodies contain safe messages only.

| Method/path                                     | Purpose                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                   | Minimal status only; 503 if production configuration is incomplete                                                                                        |
| `GET /api/session`                              | Server-derived `owner` or `meta_reviewer` role only; never credentials                                                                                    |
| `GET /api/setup`                                | Owner-only first-run service status                                                                                                                       |
| `GET /api/accounts`                             | Safe connection metadata, effective current approval gates, stored connection-time approval history, and resumable disconnect-cleanup state; never tokens |
| `DELETE /api/accounts/:id`                      | Start or resume a durable provider-revocation transaction without repeating an uncertain write                                                            |
| `POST /api/accounts/:id/disconnect/confirm`     | Atomically finish local cleanup for an owner/account-bound, expiring server transaction                                                                   |
| `POST /api/oauth/:platform/start`               | Create short-lived state/PKCE and return official authorization URL                                                                                       |
| `GET /api/oauth/:platform/callback`             | Validate/consume state, exchange code, encrypt token and connect profile                                                                                  |
| `GET or POST /api/uploadthing`                  | Official UploadThing file route: owner-authorized initiation and SDK-verified completion callback                                                         |
| `GET or HEAD /delivery/:signed-media-id`        | Resolve completed owner media and safely stream its validated UploadThing object for provider pull                                                        |
| `GET /api/storage`                              | Atomic active/reserved byte usage, 1.8 GiB cap, and finite provider-plan disclosure                                                                       |
| `POST /api/posts`                               | Validate and atomically create post/media/targets                                                                                                         |
| `GET /api/queue?view=&limit=&cursor=&platform=` | Cursor page for queue/published/failed/all; limit 1–100; no total-record cap                                                                              |
| `PATCH /api/targets/:id/cancel`                 | Cancel only before publication begins                                                                                                                     |
| `POST /api/targets/:id/retry`                   | Explicit retry of a definite `failed` target with a new key version                                                                                       |
| `POST /api/targets/:id/resolve`                 | Owner resolution of an ambiguous result after checking the platform                                                                                       |
| `DELETE /api/media/:id`                         | Delete owner media unless an active or ambiguous target still requires it                                                                                 |
| `GET /api/analytics`                            | Filtered snapshots with normalized, raw and unavailable metric names                                                                                      |
| `GET /api/analytics/:targetId`                  | Per-target metric history                                                                                                                                 |
| `POST /api/analytics/sync`                      | Owner-requested bounded analytics synchronization                                                                                                         |
| `GET /api/export`                               | Export metadata while excluding credentials, session URLs and provider file keys                                                                          |
| `POST /api/installation/delete`                 | Confirmed owner erasure plus best-effort provider token revocation                                                                                        |
| `GET /api/capabilities/:platform`               | Current configured capability gates/limitations                                                                                                           |

Queue messages contain only target ID, safe mode (`publish`, `upload`, `poll`) and request time. See [ARCHITECTURE.md](../ARCHITECTURE.md) for state and ambiguity behavior.

The Meta reviewer allowlist contains session, storage, Instagram accounts and
OAuth, queue/history/calendar data, Instagram-only post creation/cancellation,
reviewer-owned media deletion, capabilities, and reviewer-scoped analytics.
Setup/settings, TikTok, YouTube, export, installation deletion, manual retry
and ambiguity resolution are owner-only. See [META_SETUP.md](META_SETUP.md).
