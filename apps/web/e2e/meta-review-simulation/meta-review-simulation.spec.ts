import {
  expect,
  test,
  type Browser,
  type Page,
  type Route,
} from "@playwright/test";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const artifactDirectory = resolve(
  process.env.POSTLINE_REHEARSAL_DIR ??
    resolve(repositoryRoot, "artifacts/meta-review-rehearsal/uncommitted"),
);
const screenshotDirectory = resolve(artifactDirectory, "screenshots");
const reviewerEmail = "meta.reviewer@postline.example.test";
const ownerEmail = "owner@postline.example.test";
const reviewerId = "10000000-0000-4000-8000-000000000001";
const targetId = "30000000-0000-4000-8000-000000000001";
const postId = "40000000-0000-4000-8000-000000000001";
const accountId = "50000000-0000-4000-8000-000000000001";
const initialAuthorizationGeneration = "60000000-0000-4000-8000-000000000002";
const fixtureImage = resolve(repositoryRoot, "docs/screenshots/composer.png");
const profileImage = await readFile(
  resolve(repositoryRoot, "apps/web/e2e/meta-review-simulation/profile.svg"),
  "utf8",
);

type CounterName =
  | "password_auth"
  | "oauth_authorization"
  | "oauth_callback_escrow"
  | "oauth_token_exchange"
  | "account_discovery"
  | "profile_retrieval"
  | "media_upload"
  | "post_create"
  | "media_container_create"
  | "publication_status_poll"
  | "media_publish"
  | "insights_retrieval"
  | "account_revocation"
  | "sign_out";

type QueueStatus = "scheduled" | "publishing" | "published";

class SimulationBackend {
  readonly counters: Record<CounterName, number> = {
    password_auth: 0,
    oauth_authorization: 0,
    oauth_callback_escrow: 0,
    oauth_token_exchange: 0,
    account_discovery: 0,
    profile_retrieval: 0,
    media_upload: 0,
    post_create: 0,
    media_container_create: 0,
    publication_status_poll: 0,
    media_publish: 0,
    insights_retrieval: 0,
    account_revocation: 0,
    sign_out: 0,
  };

  connected: boolean;
  authorizationGeneration = initialAuthorizationGeneration;
  queueStatus: QueueStatus = "scheduled";
  postCreated = false;
  revoked = false;
  private pendingSession: string | null = null;
  private callbackEscrowSession: string | null = null;
  private completionConsumed = false;

  constructor({ connected = false }: { connected?: boolean } = {}) {
    this.connected = connected;
  }

  private increment(name: CounterName): void {
    this.counters[name] += 1;
  }

  startOAuth(sessionToken: string): boolean {
    if (!sessionToken.startsWith("SIMULATION_ONLY_") || this.revoked)
      return false;
    this.increment("oauth_authorization");
    this.pendingSession = sessionToken;
    this.callbackEscrowSession = null;
    this.completionConsumed = false;
    return true;
  }

  callback(): boolean {
    if (!this.pendingSession || this.revoked) return false;
    this.increment("oauth_callback_escrow");
    this.callbackEscrowSession = this.pendingSession;
    return true;
  }

  completeOAuth(sessionToken: string): boolean {
    if (
      this.revoked ||
      this.completionConsumed ||
      !this.callbackEscrowSession ||
      sessionToken !== this.callbackEscrowSession
    ) {
      return false;
    }
    this.completionConsumed = true;
    this.increment("oauth_token_exchange");
    this.increment("account_discovery");
    this.increment("profile_retrieval");
    this.connected = true;
    return true;
  }

  beginPublication(): void {
    if (!this.postCreated || this.revoked)
      throw new Error("Simulation publication is not authorized");
    if (this.queueStatus !== "scheduled")
      throw new Error(
        "Simulation write-ahead fence rejected a duplicate phase",
      );
    this.queueStatus = "publishing";
    this.increment("media_container_create");
    this.increment("publication_status_poll");
  }

  finishPublication(): void {
    if (this.queueStatus !== "publishing" || this.revoked)
      throw new Error("Simulation publication cannot be completed");
    this.increment("publication_status_poll");
    this.increment("media_publish");
    this.queueStatus = "published";
  }

  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    this.connected = false;
    this.authorizationGeneration = "60000000-0000-4000-8000-000000000003";
    this.increment("account_revocation");
  }

  reset(): void {
    this.connected = false;
    this.queueStatus = "scheduled";
    this.postCreated = false;
    this.revoked = false;
    this.authorizationGeneration = initialAuthorizationGeneration;
    this.pendingSession = null;
    this.callbackEscrowSession = null;
    this.completionConsumed = false;
    for (const name of Object.keys(this.counters) as CounterName[])
      this.counters[name] = 0;
  }

  async handle(route: Route): Promise<boolean> {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });

    if (url.pathname === "/profile.svg") {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: profileImage,
      });
      return true;
    }

    if (url.pathname === "/simulation/internal/password-auth") {
      this.increment("password_auth");
      await json({ ok: true });
      return true;
    }
    if (url.pathname === "/simulation/internal/upload") {
      this.increment("media_upload");
      await json({ ok: true });
      return true;
    }
    if (url.pathname === "/simulation/internal/sign-out") {
      this.increment("sign_out");
      await json({ ok: true });
      return true;
    }
    if (url.pathname === "/simulation/meta/approve") {
      if (!this.callback()) {
        await json({ message: "Simulation OAuth callback rejected." }, 400);
        return true;
      }
      await route.fulfill({
        status: 302,
        headers: {
          location:
            "http://127.0.0.1:4174/accounts?oauth=pending&platform=instagram",
        },
      });
      return true;
    }
    if (url.pathname === "/api/oauth/instagram/start") {
      const token = new URLSearchParams(request.postData() ?? "").get(
        "session_token",
      );
      if (!token || !this.startOAuth(token)) {
        await json({ message: "Simulation OAuth start rejected." }, 403);
        return true;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: metaAuthorizationPage(),
      });
      return true;
    }
    if (url.pathname === "/api/oauth/instagram/complete") {
      const token = new URLSearchParams(request.postData() ?? "").get(
        "session_token",
      );
      if (!token || !this.completeOAuth(token)) {
        await json({ message: "Simulation OAuth completion rejected." }, 403);
        return true;
      }
      await route.fulfill({
        status: 302,
        headers: {
          location: "http://127.0.0.1:4174/accounts?connected=instagram",
        },
      });
      return true;
    }

    if (!url.pathname.startsWith("/api/")) return false;
    const authorization = request.headers()["authorization"] ?? "";
    if (!authorization.startsWith("Bearer SIMULATION_ONLY_") || this.revoked) {
      await json({ message: "Reviewer authorization is not active." }, 403);
      return true;
    }
    if (url.pathname === "/api/accounts" && request.method() === "GET") {
      await json({ data: this.connected ? [this.account()] : [] });
      return true;
    }
    if (url.pathname === "/api/posts" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as {
        targets?: Array<{ platform?: string }>;
      };
      if (
        !this.connected ||
        body.targets?.length !== 1 ||
        body.targets[0]?.platform !== "instagram"
      ) {
        await json({ message: "Simulation post boundary rejected." }, 403);
        return true;
      }
      this.increment("post_create");
      this.postCreated = true;
      this.queueStatus = "scheduled";
      await json({ id: postId });
      return true;
    }
    if (url.pathname === "/api/queue" && request.method() === "GET") {
      const published = url.searchParams.get("view") === "published";
      const visible =
        this.postCreated && published === (this.queueStatus === "published");
      await json({
        data: visible ? [this.queueItem()] : [],
        nextCursor: null,
        hasMore: false,
      });
      return true;
    }
    if (url.pathname === "/api/analytics/sync" && request.method() === "POST") {
      this.increment("insights_retrieval");
      await json({ synced: 1 });
      return true;
    }
    if (url.pathname === "/api/analytics" && request.method() === "GET") {
      this.increment("insights_retrieval");
      await json({
        data: this.queueStatus === "published" ? [this.snapshot()] : [],
      });
      return true;
    }
    if (
      url.pathname === `/api/analytics/${targetId}` &&
      request.method() === "GET"
    ) {
      this.increment("insights_retrieval");
      await json({
        data: this.queueStatus === "published" ? [this.snapshot()] : [],
      });
      return true;
    }
    if (
      url.pathname.startsWith("/api/accounts/") &&
      request.method() === "DELETE"
    ) {
      this.revoke();
      await json({ ok: true, providerRevoked: true });
      return true;
    }
    if (
      [
        "/api/export",
        "/api/install",
        "/api/targets/retry",
        "/api/targets/resolve",
      ].some((path) => url.pathname.startsWith(path))
    ) {
      await json({ message: "Reviewer route is not permitted." }, 403);
      return true;
    }
    await json({ message: "Unknown simulation API route." }, 404);
    return true;
  }

  private account() {
    return {
      id: accountId,
      platform: "instagram",
      username: "postline_review_demo",
      connection_status: "connected",
      approval_state: "pending",
      stored_approval_state: "pending",
      requires_reconnect: false,
      review_testing_authorized: true,
      metadata: {
        displayName: "Postline Review Demo",
        accountType: "BUSINESS · synthetic fixture account",
        profilePictureUrl: "/profile.svg",
        providerAccountLabel: "IG_SIMULATION_ACCOUNT_0001",
      },
    };
  }

  private queueItem() {
    return {
      id: targetId,
      platform: "instagram",
      status: this.queueStatus,
      scheduled_at_utc: "2026-09-09T00:30:00.000Z",
      posts: {
        title: "SIMULATION — A calm creative reset",
        base_caption:
          "SIMULATION CONTENT: a deterministic Postline rehearsal post.",
      },
    };
  }

  private snapshot() {
    return {
      id: "70000000-0000-4000-8000-000000000001",
      post_target_id: targetId,
      platform: "instagram",
      captured_at: "2026-09-08T01:00:00.000Z",
      period_start: "2026-09-01T00:00:00.000Z",
      period_end: "2026-09-08T00:00:00.000Z",
      normalized_metrics: {
        views: 18_400,
        reach: 15_920,
        impressions: 21_100,
        likes: 1_240,
        comments: 148,
        shares: 96,
        saves: 112,
        followers_delta: 74,
        profile_actions: 318,
      },
      raw_metrics: {
        reach: 15_920,
        impressions: 21_100,
        profile_activity: 318,
      },
      unavailable_metrics: [
        "watch_time_minutes",
        "average_view_duration_seconds",
      ],
      authorization_generation: this.authorizationGeneration,
      post_targets: {
        metadata: { contentType: "feed_image", simulation: true },
        posts: {
          id: postId,
          title: "SIMULATION — A calm creative reset",
        },
      },
    };
  }
}

function metaAuthorizationPage(): string {
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Simulated Meta authorization</title>
  <style>
  body{margin:0;padding-top:32px;background:#f5f7fb;color:#172554;font:16px system-ui}.watermark{position:fixed;inset:0 0 auto;height:32px;display:grid;place-items:center;background:#7c2d12;color:white;font-size:12px;font-weight:700;letter-spacing:.14em}.card{width:620px;margin:72px auto;padding:42px;border:1px solid #dbe3ef;border-radius:18px;background:white;box-shadow:0 18px 45px #17255414}.brand{font-size:28px;font-weight:800;color:#1877f2}.profile{display:flex;align-items:center;gap:18px;margin:30px 0;padding:20px;background:#f8fafc;border-radius:12px}.profile img{width:70px;height:70px;border-radius:50%}.profile strong,.profile span{display:block}.profile span{color:#64748b;margin-top:5px}.notice{padding:12px;border-radius:8px;background:#fff7ed;color:#9a3412;font-weight:700}button{width:100%;padding:14px;border:0;border-radius:9px;background:#1877f2;color:white;font:700 16px system-ui;cursor:pointer}</style></head>
  <body><div class="watermark">SIMULATION — NOT FOR META SUBMISSION</div><main class="card">
  <div class="brand">Meta · Local provider simulation</div><h1>Authorize Postline Review Demo</h1>
  <p>This deterministic page replaces Meta OAuth. It makes no external request.</p>
  <div class="profile"><img src="http://127.0.0.1:4174/profile.svg" alt="Synthetic Instagram profile"><div><strong>Postline Review Demo</strong><span>@postline_review_demo · BUSINESS</span></div></div>
  <p class="notice">Synthetic professional account · no real Instagram identity</p>
  <form method="post" action="http://127.0.0.1:8787/simulation/meta/approve"><button type="submit">Approve synthetic professional account</button></form>
  </main></body></html>`;
}

async function createRecordedPage(
  browser: Browser,
  backend: SimulationBackend,
  password: string,
  initialAuth: boolean,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
    recordVideo: {
      dir: resolve(artifactDirectory, "raw-videos"),
      size: { width: 1440, height: 900 },
    },
  });
  await context.addInitScript(
    ({ ephemeralPassword, authenticated }) => {
      Object.defineProperty(window, "__POSTLINE_SIMULATION_PASSWORD__", {
        configurable: false,
        enumerable: false,
        value: ephemeralPassword,
        writable: false,
      });
      if (
        authenticated &&
        sessionStorage.getItem("postline-meta-review-simulation-revoked") !==
          "true"
      ) {
        sessionStorage.setItem(
          "postline-meta-review-simulation-authenticated",
          "true",
        );
        sessionStorage.setItem(
          "postline-meta-review-simulation-token",
          `SIMULATION_ONLY_${crypto.randomUUID()}`,
        );
      }
    },
    { ephemeralPassword: password, authenticated: initialAuth },
  );
  const page = await context.newPage();
  const externalAttempts: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      externalAttempts.push(
        `${route.request().method()} ${url.origin}${url.pathname}`,
      );
      await route.abort("blockedbyclient");
      return;
    }
    if (await backend.handle(route)) return;
    await route.continue();
  });
  return { context, page, externalAttempts };
}

async function titleCard(page: Page, number: string, title: string) {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#172554;color:white;display:grid;place-items:center;height:100vh;font-family:system-ui"><div style="text-align:center"><p style="letter-spacing:.2em;color:#fdba74">POSTLINE META REVIEW REHEARSAL · ${number}</p><h1 style="font-size:48px;max-width:900px">${title}</h1><p>Deterministic local simulation · no provider contact</p></div><div style="position:fixed;inset:0 0 auto;height:32px;display:grid;place-items:center;background:#7c2d12;font-size:12px;font-weight:700;letter-spacing:.14em">SIMULATION — NOT FOR META SUBMISSION</div></body></html>`,
  );
  await page.waitForTimeout(900);
}

async function screenshot(page: Page, name: string) {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(screenshotDirectory, `${name}.png`),
    fullPage: true,
  });
}

async function finishRecording(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  page: Page,
  fileName: string,
) {
  const video = page.video();
  if (!video) throw new Error("Playwright did not create a recording");
  await page.waitForTimeout(600);
  await context.close();
  await mkdir(artifactDirectory, { recursive: true });
  await copyFile(await video.path(), resolve(artifactDirectory, fileName));
}

async function writeEvidence(
  flow: string,
  backend: SimulationBackend,
  externalAttempts: string[],
) {
  await writeFile(
    resolve(artifactDirectory, `${flow}-evidence.json`),
    `${JSON.stringify(
      {
        flow,
        providerCalls: backend.counters,
        externalNetworkAttempts: externalAttempts,
        providerCallsWereSimulated: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test.beforeAll(async () => {
  await mkdir(resolve(artifactDirectory, "raw-videos"), { recursive: true });
  await mkdir(screenshotDirectory, { recursive: true });
});

test("01 reviewer login and connect Instagram", async ({ browser }) => {
  const backend = new SimulationBackend();
  const password = randomBytes(24).toString("base64url");
  const { context, page, externalAttempts } = await createRecordedPage(
    browser,
    backend,
    password,
    false,
  );
  await titleCard(page, "01", "Reviewer login and connect Instagram");
  await page.goto("/login?review=meta");
  await expect(
    page.getByText("SIMULATION — NOT FOR META SUBMISSION"),
  ).toBeVisible();
  await screenshot(page, "01-01-reviewer-login");
  await page.getByLabel("Email address").fill(reviewerEmail);
  await page.getByLabel("Temporary password").fill(password);
  await page
    .getByRole("button", { name: "Complete simulated Turnstile challenge" })
    .click();
  await expect(
    page.getByText("Test-environment verification complete"),
  ).toBeVisible();
  await screenshot(page, "01-02-turnstile-complete");
  await page.getByRole("button", { name: "Sign in for Meta review" }).click();
  await expect(
    page.getByRole("heading", { name: "Connected accounts" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByText("TikTok")).toHaveCount(0);
  await expect(page.getByText("YouTube")).toHaveCount(0);
  await screenshot(page, "01-03-reviewer-accounts");
  await page.getByRole("button", { name: "Connect Instagram" }).click();
  await expect(
    page.getByRole("heading", { name: "Authorize Postline Review Demo" }),
  ).toBeVisible();
  await screenshot(page, "01-04-simulated-meta-authorization");
  await page
    .getByRole("button", { name: "Approve synthetic professional account" })
    .click();
  await expect(
    page.getByText("Postline Review Demo", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("@postline_review_demo")).toBeVisible();
  await expect(
    page.getByText(/BUSINESS · synthetic fixture account/),
  ).toBeVisible();
  await expect(page.getByAltText("Synthetic Instagram profile")).toBeVisible();
  await screenshot(page, "01-05-connected-instagram");

  expect(backend.counters).toMatchObject({
    password_auth: 1,
    oauth_authorization: 1,
    oauth_callback_escrow: 1,
    oauth_token_exchange: 1,
    account_discovery: 1,
    profile_retrieval: 1,
  });
  expect(externalAttempts).toEqual([]);
  await writeEvidence("01-login-connect", backend, externalAttempts);
  await finishRecording(context, page, "01-reviewer-login-and-connect.webm");
});

test("02 create, schedule and simulate fenced publication", async ({
  browser,
}) => {
  const backend = new SimulationBackend({ connected: true });
  const password = randomBytes(24).toString("base64url");
  const { context, page, externalAttempts } = await createRecordedPage(
    browser,
    backend,
    password,
    true,
  );
  await titleCard(page, "02", "Create, schedule and simulate publishing");
  await page.goto("/composer");
  await expect(page.getByTestId("simulation-badge")).toBeVisible();
  await expect(page.getByText("TikTok")).toHaveCount(0);
  await expect(page.getByText("YouTube")).toHaveCount(0);
  await screenshot(page, "02-01-instagram-composer");

  await page.getByLabel("Content type").selectOption("feed_image");
  await page.locator('input[type="file"]').setInputFiles(fixtureImage);
  await expect(
    page.getByText(/Ready · server-confirmed UploadThing file/),
  ).toBeVisible();
  await page
    .getByLabel("Internal title")
    .fill("SIMULATION — A calm creative reset");
  await page
    .getByLabel("Base caption")
    .fill("SIMULATION CONTENT: a deterministic Postline rehearsal post.");
  await page
    .getByLabel("Instagram caption override")
    .fill("SIMULATION CONTENT: a deterministic Postline rehearsal post.");
  await screenshot(page, "02-02-media-and-caption-ready");
  await page.getByRole("button", { name: /Schedule 1 target/ }).click();
  await expect(
    page.getByText("Scheduled 1 independent platform target."),
  ).toBeVisible();
  await screenshot(page, "02-03-post-scheduled");

  await page.getByRole("link", { name: "Queue" }).click();
  await expect(
    page.getByText("SIMULATION — A calm creative reset"),
  ).toBeVisible();
  await expect(page.getByText("Scheduled", { exact: true })).toBeVisible();
  await screenshot(page, "02-04-queue-scheduled");
  backend.beginPublication();
  await page.reload();
  await expect(page.getByText("Publishing", { exact: true })).toBeVisible();
  await screenshot(page, "02-05-fenced-provider-phases");
  backend.finishPublication();
  await page.getByRole("link", { name: "Published" }).click();
  await expect(
    page.getByText("SIMULATION — A calm creative reset"),
  ).toBeVisible();
  await expect(page.getByText("18.4k")).toBeVisible();
  await expect(page.getByRole("button", { name: /Manual retry/i })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: /Resolve/i })).toHaveCount(0);
  await screenshot(page, "02-06-simulated-publication-history");

  expect(backend.counters).toMatchObject({
    media_upload: 1,
    post_create: 1,
    media_container_create: 1,
    publication_status_poll: 2,
    media_publish: 1,
  });
  expect(() => backend.finishPublication()).toThrow(/cannot be completed/);
  expect(externalAttempts).toEqual([]);
  await writeEvidence("02-create-publish", backend, externalAttempts);
  await finishRecording(context, page, "02-create-schedule-and-publish.webm");
});

test("03 view generation-scoped Instagram insights", async ({ browser }) => {
  const backend = new SimulationBackend({ connected: true });
  backend.postCreated = true;
  backend.beginPublication();
  backend.finishPublication();
  for (const name of Object.keys(backend.counters) as CounterName[])
    backend.counters[name] = 0;
  const password = randomBytes(24).toString("base64url");
  const { context, page, externalAttempts } = await createRecordedPage(
    browser,
    backend,
    password,
    true,
  );
  await titleCard(page, "03", "View current-generation Instagram insights");
  await page.goto("/analytics");
  await expect(
    page.getByRole("heading", { name: "Instagram review analytics" }),
  ).toBeVisible();
  await expect(
    page.getByText("SIMULATION — A calm creative reset"),
  ).toBeVisible();
  await expect(page.getByLabel("Analytics platform")).toHaveValue("instagram");
  await expect(
    page.getByLabel("Analytics platform").locator("option"),
  ).toHaveCount(1);
  await screenshot(page, "03-01-instagram-analytics");
  await page.locator("select").first().selectOption("90");
  await expect(
    page.getByText("Selected reporting window: 90 days"),
  ).toBeVisible();
  await screenshot(page, "03-02-date-filtered-analytics");
  await page
    .getByRole("link", { name: "Open SIMULATION — A calm creative reset" })
    .click();
  await expect(
    page.getByRole("heading", { name: "SIMULATION — A calm creative reset" }),
  ).toBeVisible();
  await expect(page.getByText("15,920")).toBeVisible();
  await expect(page.getByText("21,100")).toBeVisible();
  await expect(page.getByText("318")).toBeVisible();
  await expect(page.getByRole("button", { name: /Export/i })).toHaveCount(0);
  await screenshot(page, "03-03-direct-analytics-detail");

  expect(backend.counters.insights_retrieval).toBeGreaterThanOrEqual(3);
  expect(externalAttempts).toEqual([]);
  await writeEvidence("03-insights", backend, externalAttempts);
  await finishRecording(context, page, "03-view-instagram-insights.webm");
});

test("04 authorization rotation revokes the simulated reviewer", async ({
  browser,
}) => {
  const backend = new SimulationBackend({ connected: true });
  backend.postCreated = true;
  backend.beginPublication();
  backend.finishPublication();
  for (const name of Object.keys(backend.counters) as CounterName[])
    backend.counters[name] = 0;
  const password = randomBytes(24).toString("base64url");
  const { context, page, externalAttempts } = await createRecordedPage(
    browser,
    backend,
    password,
    true,
  );
  await titleCard(page, "04", "Revocation and reviewer restrictions");
  await page.goto("/accounts");
  await expect(
    page.getByText("Postline Review Demo", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Setup status" })).toHaveCount(0);
  await screenshot(page, "04-01-active-reviewer");
  backend.revoke();
  await page.evaluate(() => {
    sessionStorage.removeItem("postline-meta-review-simulation-authenticated");
    sessionStorage.removeItem("postline-meta-review-simulation-token");
    sessionStorage.setItem("postline-meta-review-simulation-revoked", "true");
  });
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await screenshot(page, "04-02-access-revoked");
  const stale = backend.completeOAuth("SIMULATION_ONLY_STALE_SESSION");
  expect(stale).toBe(false);
  expect(backend.connected).toBe(false);
  expect(externalAttempts).toEqual([]);
  await writeEvidence("04-revocation", backend, externalAttempts);
  await finishRecording(context, page, "04-revocation-and-restrictions.webm");
});

test("security controls reject magic link, callback-only, cross-session completion, and reset state", async ({
  browser,
}) => {
  const backend = new SimulationBackend();
  const sessionA = "SIMULATION_ONLY_SESSION_A";
  const sessionB = "SIMULATION_ONLY_SESSION_B";
  expect(backend.startOAuth(sessionA)).toBe(true);
  expect(backend.callback()).toBe(true);
  expect(backend.counters.oauth_token_exchange).toBe(0);
  expect(backend.connected).toBe(false);
  expect(backend.completeOAuth(sessionB)).toBe(false);
  expect(backend.counters.oauth_token_exchange).toBe(0);
  expect(backend.connected).toBe(false);
  expect(backend.completeOAuth(sessionA)).toBe(true);
  expect(backend.completeOAuth(sessionA)).toBe(false);
  expect(backend.counters.oauth_token_exchange).toBe(1);

  const password = randomBytes(24).toString("base64url");
  const { context, page, externalAttempts } = await createRecordedPage(
    browser,
    backend,
    password,
    false,
  );
  await page.goto("/login");
  await page.getByLabel("Email address").fill(reviewerEmail);
  await page
    .getByRole("button", { name: "Complete simulated Turnstile challenge" })
    .click();
  await page.getByRole("button", { name: "Send magic link" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Passwordless reviewer sign-in is disabled",
  );
  expect(externalAttempts).toEqual([]);
  await context.close();

  backend.reset();
  expect(backend.connected).toBe(false);
  expect(backend.postCreated).toBe(false);
  expect(backend.authorizationGeneration).toBe(initialAuthorizationGeneration);
  expect(Object.values(backend.counters).every((value) => value === 0)).toBe(
    true,
  );
  expect(ownerEmail).toBe("owner@postline.example.test");
  expect(reviewerId).not.toBe(accountId);
});
