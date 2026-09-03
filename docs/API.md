# Worker API

All `/api/*` routes except OAuth provider callbacks require a valid Supabase bearer session whose verified email equals `OWNER_EMAIL`. State-changing operations are authorized again by RLS/RPC. JSON error bodies contain safe messages only.

| Method/path                                     | Purpose                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /health`                                   | Minimal status only; 503 if production configuration is incomplete                           |
| `GET /api/setup`                                | Owner-only first-run service status                                                          |
| `GET /api/accounts`                             | Safe connection metadata, never tokens                                                       |
| `DELETE /api/accounts/:id`                      | Revoke provider token where supported, then destroy stored credentials                       |
| `POST /api/oauth/:platform/start`               | Create short-lived state/PKCE and return official authorization URL                          |
| `GET /api/oauth/:platform/callback`             | Validate/consume state, exchange code, encrypt token and connect profile                     |
| `POST /api/uploads`                             | Validate media, create random R2 key and return single/multipart signed operation            |
| `POST /api/uploads/:id/part`                    | Return a short-lived signed direct-to-R2 part URL                                            |
| `GET or HEAD /delivery/:opaque-key`             | Serve one private R2 object after short-lived HMAC verification; used only for provider pull |
| `POST /api/uploads/:id/complete`                | Complete multipart or verify direct object and mark media complete                           |
| `POST /api/posts`                               | Validate and atomically create post/media/targets                                            |
| `GET /api/queue?view=&limit=&cursor=&platform=` | Cursor page for queue/published/failed/all; limit 1–100; no total-record cap                 |
| `PATCH /api/targets/:id/cancel`                 | Cancel only before publication begins                                                        |
| `POST /api/targets/:id/retry`                   | Explicit retry of a definite `failed` target with a new key version                          |
| `POST /api/targets/:id/resolve`                 | Owner resolution of an ambiguous result after checking the platform                          |
| `DELETE /api/media/:id`                         | Delete owner media unless an active or ambiguous target still requires it                    |
| `GET /api/analytics`                            | Filtered snapshots with normalized, raw and unavailable metric names                         |
| `GET /api/analytics/:targetId`                  | Per-target metric history                                                                    |
| `POST /api/analytics/sync`                      | Owner-requested bounded analytics synchronization                                            |
| `GET /api/export`                               | Export metadata while excluding credentials, session URLs and R2 object keys                 |
| `POST /api/installation/delete`                 | Confirmed owner erasure plus best-effort provider token revocation                           |
| `GET /api/capabilities/:platform`               | Current configured capability gates/limitations                                              |

Queue messages contain only target ID, safe mode (`publish`, `upload`, `poll`) and request time. See [ARCHITECTURE.md](../ARCHITECTURE.md) for state and ambiguity behavior.
