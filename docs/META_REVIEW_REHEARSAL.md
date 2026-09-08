# Meta App Review rehearsal

This harness produces a deterministic, high-fidelity walkthrough of Postline's
restricted Meta reviewer experience. It is a **simulation and is not valid final
Meta submission evidence**. Every frame is watermarked `SIMULATION — NOT FOR
META SUBMISSION`.

The rehearsal uses the real Postline React pages, navigation, reviewer-visible
route restrictions and browser OAuth choreography. A test-only React dependency
adapter supplies password authentication, Turnstile and upload behavior. A
Playwright-owned localhost backend supplies deterministic Worker/provider
responses and records call counts. Neither adapter is installed by the
production entrypoint.

Before recording, the one-command generator also runs the production
`processClaimedQueueJob`/Instagram adapter state-machine tests with provider
calls stubbed. The browser fixture mirrors those durable phases for presentation;
it does not replace the production state-machine verification.

## Safety properties

- Browser requests are intercepted before network access. Any hostname other
  than `127.0.0.1` or `localhost` aborts the test.
- No Meta, Instagram, UploadThing, Supabase, Cloudflare or other provider endpoint
  is contacted during browser simulation.
- There is no Worker simulation endpoint, production query switch, production
  simulation flag or committed credential.
- The reviewer password and browser token are generated ephemerally for each
  run. They are not printed, reported or stored in artifacts.
- Synthetic tokens use a conspicuous `SIMULATION_ONLY_` prefix.
- Production build verification fails if simulation identities, fixture values,
  internal test routes, tokens or the simulation watermark enter a production
  web bundle.
- Generated output lives under ignored `artifacts/` and must not be committed.

## Synthetic data

| Item                  | Fixture                                          |
| --------------------- | ------------------------------------------------ |
| Reviewer email        | `meta.reviewer@postline.example.test`            |
| Reviewer UUID         | deterministic UUID in the test-only entrypoint   |
| Owner email           | `owner@postline.example.test`                    |
| Instagram username    | `postline_review_demo`                           |
| Display name          | `Postline Review Demo`                           |
| Account type          | `BUSINESS`                                       |
| Provider account      | an obviously synthetic fixture identifier        |
| Profile image         | local `profile.svg` fixture                      |
| Post media            | repository-owned `docs/screenshots/composer.png` |
| Caption and analytics | visibly marked deterministic simulation data     |

No fixture is intended to resemble or authenticate a real account.

## Generate locally

Prerequisites are Node.js 24, pnpm through Corepack, Chromium for Playwright,
and `ffmpeg`/`ffprobe` for MP4 conversion and media validation.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm meta-review:rehearsal
```

Output is written to:

```text
artifacts/meta-review-rehearsal/<full-commit-sha>/
```

The generator recreates only the directory for the exact validated Git commit.
It produces four WebM recordings, H.264 MP4 copies when video tools are present,
a combined three-flow MP4, representative screenshots, call/network evidence,
an HTML/Markdown report and a checksum manifest.

## CI execution

Run **Meta review rehearsal** manually from GitHub Actions and explicitly choose
the simulation branch. The workflow has read-only repository permission, no
production environment, no secrets and no deploy command. It starts a disposable
Supabase stack for pgTAP and real Auth/PostgREST verification, runs the complete
checks, generates the browser rehearsal and uploads a seven-day artifact.

## Recorded flows

1. Password reviewer login, simulated Turnstile, restricted navigation, local
   Meta authorization page, callback escrow, authenticated completion and the
   synthetic Instagram business account.
2. Instagram-only composer, local media upload, scheduling, queued state,
   deterministic fenced provider phases and simulated publication history.
3. Current-generation Instagram analytics, date filter and direct-target detail.
4. Optional authorization rotation showing session denial and inaccessible old
   state.

## Reset and cleanup

Each scenario gets a new browser context, ephemeral password/token and in-memory
backend. The backend's reset assertion clears connections, posts, OAuth state,
authorization state and counters. Delete the ignored artifact directory when it
is no longer needed; CI artifacts expire after seven days.

## Mapping to the real Meta recording

The final Meta recording should follow the same visible sequence, but it must use
the intentionally created reviewer identity, real Turnstile/Supabase verification,
the real Meta consent screen, a Meta-provided Instagram professional test account,
real callback/token exchange, real provider publication and official insights.
The production migrations must be applied and the Worker/database preflight must
pass before that recording.

Human steps still required later:

1. Review and merge production-intended code separately from this disposable
   rehearsal branch.
2. Apply the reviewed migrations before deploying the corresponding Worker.
3. Configure the real reviewer account and credentials privately.
4. Enable review mode only for the controlled review window.
5. Perform and record real OAuth/publishing/insights behavior without the
   simulation watermark.
6. Complete Meta declarations and submission manually; do not claim provider
   approval until Meta grants it.
