# Worker API

All `/api/*` routes except OAuth provider callbacks and UploadThing's signed callback request require a valid Supabase bearer session whose verified email equals `OWNER_EMAIL`. UploadThing upload initiation authenticates the same owner inside file-route middleware; the official SDK verifies callback signatures. State-changing operations are authorized again by RLS/RPC. JSON error bodies contain safe messages only.

| Method/path                                     | Purpose                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /health`                                   | Minimal status only; 503 if production configuration is incomplete                                 |
| `GET /api/setup`                                | Owner-only first-run service status                                                                |
| `GET /api/accounts`                             | Safe connection metadata, never tokens                                                             |
| `DELETE /api/accounts/:id`                      | Revoke provider token where supported, then destroy stored credentials                             |
| `POST /api/oauth/:platform/start`               | Create short-lived state/PKCE and return official authorization URL                                |
| `GET /api/oauth/:platform/callback`             | Validate/consume state, exchange code, encrypt token and connect profile                           |
| `GET or POST /api/uploadthing`                  | Official UploadThing file route: owner-authorized initiation and SDK-verified completion callback  |
| `GET or HEAD /delivery/:signed-media-id`        | Resolve completed owner media and safely stream its validated UploadThing object for provider pull |
| `GET /api/storage`                              | Atomic active/reserved byte usage, 1.8 GiB cap, and finite provider-plan disclosure                |
| `POST /api/posts`                               | Validate and atomically create post/media/targets                                                  |
| `GET /api/queue?view=&limit=&cursor=&platform=` | Cursor page for queue/published/failed/all; limit 1–100; no total-record cap                       |
| `PATCH /api/targets/:id/cancel`                 | Cancel only before publication begins                                                              |
| `POST /api/targets/:id/retry`                   | Explicit retry of a definite `failed` target with a new key version                                |
| `POST /api/targets/:id/resolve`                 | Owner resolution of an ambiguous result after checking the platform                                |
| `DELETE /api/media/:id`                         | Delete owner media unless an active or ambiguous target still requires it                          |
| `GET /api/analytics`                            | Filtered snapshots with normalized, raw and unavailable metric names                               |
| `GET /api/analytics/:targetId`                  | Per-target metric history                                                                          |
| `POST /api/analytics/sync`                      | Owner-requested bounded analytics synchronization                                                  |
| `GET /api/export`                               | Export metadata while excluding credentials, session URLs and provider file keys                   |
| `POST /api/installation/delete`                 | Confirmed owner erasure plus best-effort provider token revocation                                 |
| `GET /api/capabilities/:platform`               | Current configured capability gates/limitations                                                    |

Queue messages contain only target ID, safe mode (`publish`, `upload`, `poll`) and request time. See [ARCHITECTURE.md](../ARCHITECTURE.md) for state and ambiguity behavior.
