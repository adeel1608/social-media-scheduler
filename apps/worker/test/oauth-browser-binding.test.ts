import { encryptSecret } from "@scheduler/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";
import {
  hashOAuthBrowserBinding,
  oauthCompletionCookieName,
  oauthCookieName,
  oauthHash,
  readSingleCookie,
  type OAuthBindingRecord,
  type OAuthCompletionRecord,
} from "../src/oauth-binding";

const ownerId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const state = "state-value-with-enough-random-looking-bytes-1234";
const binding = "binding-value-with-enough-random-looking-bytes-12";
const completion = "completion-handle-with-enough-random-bytes-123";
const encryptionKey = btoa("A".repeat(32));

const environment = {
  ENVIRONMENT: "development",
  APP_URL: "https://postline.example.test",
  WORKER_PUBLIC_URL: "https://worker.example.test",
  OWNER_EMAIL: "owner@postline.dev",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "public-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  TOKEN_ENCRYPTION_KEY: encryptionKey,
  TOKEN_ENCRYPTION_KEY_VERSION: "v1",
  META_APP_ID: "synthetic-app-id",
  META_APP_SECRET: "synthetic-app-secret",
  META_REDIRECT_URI: "https://worker.example.test/api/oauth/instagram/callback",
  META_GRAPH_VERSION: "v23.0",
  META_APP_REVIEW_APPROVED: "false",
  META_REVIEW_MODE: "false",
} as Env;

afterEach(() => vi.unstubAllGlobals());

function jwt(
  authSessionId = sessionId,
  expiresAt = Math.floor(Date.now() / 1_000) + 600,
  password = false,
) {
  const payload = btoa(
    JSON.stringify({
      session_id: authSessionId,
      exp: expiresAt,
      ...(password ? { amr: [{ method: "password" }] } : {}),
    }),
  ).replace(/=/g, "");
  return `header.${payload}.signature`;
}

async function record(
  overrides: Partial<OAuthBindingRecord & Record<string, unknown>> = {},
): Promise<OAuthCompletionRecord & Record<string, unknown>> {
  const [verifier, code] = await Promise.all([
    encryptSecret("verifier", encryptionKey, "v1"),
    encryptSecret("synthetic-code", encryptionKey, "v1"),
  ]);
  const base: OAuthBindingRecord & Record<string, unknown> = {
    id: "33333333-3333-4333-8333-333333333333",
    state_hash: await oauthHash(state),
    owner_id: ownerId,
    authorization_context: "owner",
    authorization_generation: null,
    auth_session_id: sessionId,
    initiating_email: "owner@postline.dev",
    redirect_uri: environment.META_REDIRECT_URI,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    encrypted_pkce_verifier: verifier.ciphertext,
    pkce_nonce: verifier.nonce,
    encryption_key_version: verifier.keyVersion,
    callback_received_at: new Date().toISOString(),
    completion_consumed_at: new Date().toISOString(),
    pending_authorization_code: code.ciphertext,
    pending_authorization_code_nonce: code.nonce,
    pending_authorization_code_key_version: code.keyVersion,
    pending_completion_handle_hash: await oauthHash(completion),
  };
  const value = { ...base, ...overrides } as OAuthCompletionRecord &
    Record<string, unknown>;
  value.browser_binding_hash = await hashOAuthBrowserBinding(binding, value);
  return value;
}

function callbackRequest(
  cookie = binding,
  query = `code=synthetic-code&state=${encodeURIComponent(state)}`,
) {
  return new Request(
    `https://worker.example.test/api/oauth/instagram/callback?${query}`,
    {
      headers: cookie
        ? { Cookie: `${oauthCookieName("instagram")}=${cookie}` }
        : {},
    },
  );
}

function completionRequest(options: {
  token?: string;
  browserCookie?: string;
  completionCookie?: string;
  duplicateBrowserCookie?: boolean;
}) {
  const cookies = [
    `${oauthCookieName("instagram")}=${options.browserCookie ?? binding}`,
    `${oauthCompletionCookieName("instagram")}=${options.completionCookie ?? completion}`,
  ];
  if (options.duplicateBrowserCookie)
    cookies.push(`${oauthCookieName("instagram")}=${binding}`);
  return new Request(
    "https://worker.example.test/api/oauth/instagram/complete",
    {
      method: "POST",
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        Cookie: cookies.join("; "),
      },
    },
  );
}

function isProviderRequest(value: string) {
  const hostname = new URL(value).hostname;
  return hostname === "api.instagram.com" || hostname === "graph.instagram.com";
}

function callbackFetch(
  oauthRecord: OAuthCompletionRecord & Record<string, unknown>,
  recordCallback = true,
) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/rest/v1/oauth_states?"))
      return Response.json([oauthRecord]);
    if (url.endsWith("/rest/v1/rpc/record_bound_oauth_callback"))
      return Response.json(recordCallback ? [oauthRecord] : []);
    throw new Error(`unexpected callback request ${new URL(url).pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

interface CompletionFetchOptions {
  userId?: string;
  email?: string;
  authOk?: boolean;
  consume?: boolean;
  reviewerAdmin?: Record<string, unknown> | null;
  reviewerGeneration?: string | null;
  profileStatus?: number;
  profileBody?: Record<string, unknown>;
  profileNetworkFailure?: boolean;
  tokenExchangeStatus?: number;
  tokenExchangeNetworkFailure?: boolean;
  persistenceStatus?: number;
}

function completionFetch(
  oauthRecord: OAuthCompletionRecord & Record<string, unknown>,
  options: CompletionFetchOptions = {},
) {
  const calls: string[] = [];
  let consumed = false;
  const userId = options.userId ?? ownerId;
  const email = options.email ?? "owner@postline.dev";
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/v1/user")) {
        return options.authOk === false
          ? Response.json({}, { status: 401 })
          : Response.json({ id: userId, email });
      }
      if (url.includes("/auth/v1/admin/users/")) {
        if (options.reviewerAdmin === null)
          return Response.json({}, { status: 404 });
        return Response.json(
          options.reviewerAdmin ?? {
            id: userId,
            email,
            email_confirmed_at: new Date().toISOString(),
            is_anonymous: false,
          },
        );
      }
      if (url.endsWith("/rest/v1/rpc/current_meta_review_authorization")) {
        return Response.json(
          options.reviewerGeneration === null
            ? null
            : {
                generation:
                  options.reviewerGeneration ??
                  oauthRecord.authorization_generation,
              },
        );
      }
      if (url.includes("/rest/v1/oauth_states?")) {
        const expected = encodeURIComponent(
          String(oauthRecord.pending_completion_handle_hash),
        );
        return Response.json(url.includes(expected) ? [oauthRecord] : []);
      }
      if (url.endsWith("/rest/v1/rpc/consume_oauth_completion")) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const authorized =
          options.consume !== false &&
          !consumed &&
          Date.parse(oauthRecord.expires_at) > Date.now() &&
          body.p_current_owner_id === oauthRecord.owner_id &&
          body.p_current_email === oauthRecord.initiating_email &&
          body.p_current_auth_session_id === oauthRecord.auth_session_id &&
          (oauthRecord.authorization_context !== "meta_review" ||
            options.reviewerGeneration === undefined ||
            options.reviewerGeneration ===
              oauthRecord.authorization_generation);
        if (!authorized) return Response.json([]);
        consumed = true;
        return Response.json([
          {
            ...oauthRecord,
            completion_consumed_at: new Date().toISOString(),
          },
        ]);
      }
      if (url.endsWith("/rest/v1/rpc/persist_bound_oauth_account"))
        return Response.json(
          { id: "account-id" },
          { status: options.persistenceStatus ?? 200 },
        );
      if (url === "https://api.instagram.com/oauth/access_token") {
        if (options.tokenExchangeNetworkFailure)
          throw new Error("synthetic token exchange network failure");
        return Response.json(
          {
            access_token: "synthetic-short-token",
            user_id: 123,
          },
          { status: options.tokenExchangeStatus ?? 200 },
        );
      }
      if (url.startsWith("https://graph.instagram.com/access_token"))
        return Response.json({
          access_token: "synthetic-long-token",
          expires_in: 3600,
        });
      if (url.startsWith("https://graph.instagram.com/v23.0/me")) {
        if (options.profileNetworkFailure)
          throw new Error("synthetic profile network failure");
        return Response.json(
          options.profileBody ?? {
            user_id: "12345678901234567",
            username: "review-fixture",
            account_type: "BUSINESS",
          },
          { status: options.profileStatus ?? 200 },
        );
      }
      throw new Error(`unexpected completion request ${new URL(url).pathname}`);
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

function expectNoProviderSideEffect(calls: string[]) {
  expect(calls.some(isProviderRequest)).toBe(false);
  expect(
    calls.some((url) => url.endsWith("/persist_bound_oauth_account")),
  ).toBe(false);
}

describe("OAuth callback escrow and authenticated completion", () => {
  it("records only encrypted pending completion at callback and performs zero provider work", async () => {
    const fixture = await record();
    const { calls, fetcher } = callbackFetch(fixture);
    const response = await app.fetch(callbackRequest(), environment);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postline.example.test/accounts?oauth=pending&platform=instagram",
    );
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain(oauthCookieName("instagram"));
    expect(cookies).toContain(oauthCompletionCookieName("instagram"));
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("SameSite=None");
    expectNoProviderSideEffect(calls);
    const escrowCall = fetcher.mock.calls.find(([input]) =>
      String(input).endsWith("/record_bound_oauth_callback"),
    );
    const escrowBody = JSON.parse(
      String((escrowCall?.[1] as RequestInit | undefined)?.body),
    ) as Record<string, unknown>;
    expect(escrowBody.p_authorization_code).not.toBe("synthetic-code");
    expect(escrowBody.p_completion_handle_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same browser, user, email, and Auth session performs exactly one exchange and persistence", async () => {
    const fixture = await record();
    const { calls } = completionFetch(fixture);
    const response = await app.fetch(
      completionRequest({ token: jwt() }),
      environment,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postline.example.test/accounts?connected=instagram",
    );
    expect(
      calls.filter(
        (url) => url === "https://api.instagram.com/oauth/access_token",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.endsWith("/persist_bound_oauth_account")),
    ).toHaveLength(1);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const profileRequest = new URL(
      calls.find((url) =>
        url.startsWith("https://graph.instagram.com/v23.0/me"),
      )!,
    );
    expect(profileRequest.searchParams.get("fields")?.split(",")).toContain(
      "user_id",
    );
  });

  it("completes the reviewer form flow with current Instagram profile semantics", async () => {
    const generation = "77777777-7777-4777-8777-777777777777";
    const reviewerId = "88888888-8888-4888-8888-888888888888";
    const reviewerEmail = "reviewer@postline.dev";
    const fixture = await record({
      owner_id: reviewerId,
      initiating_email: reviewerEmail,
      authorization_context: "meta_review",
      authorization_generation: generation,
    });
    const reviewEnvironment = {
      ...environment,
      META_REVIEW_MODE: "true",
      META_REVIEWER_USER_ID: reviewerId,
      META_REVIEWER_EMAIL: reviewerEmail,
    } as Env;
    const { calls, fetcher } = completionFetch(fixture, {
      userId: reviewerId,
      email: reviewerEmail,
      reviewerGeneration: generation,
    });
    const token = jwt(sessionId, undefined, true);
    const request = new Request(
      "https://worker.example.test/api/oauth/instagram/complete",
      {
        method: "POST",
        headers: {
          Origin: reviewEnvironment.APP_URL,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `${oauthCookieName("instagram")}=${binding}; ${oauthCompletionCookieName("instagram")}=${completion}`,
        },
        body: new URLSearchParams({ session_token: token }),
      },
    );

    const response = await app.fetch(request, reviewEnvironment);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://postline.example.test/accounts?connected=instagram",
    );
    expect(
      calls.filter(
        (url) => url === "https://api.instagram.com/oauth/access_token",
      ),
    ).toHaveLength(1);
    const persistenceCall = fetcher.mock.calls.find(([input]) =>
      String(input).endsWith("/persist_bound_oauth_account"),
    );
    const persistenceBody = JSON.parse(
      String((persistenceCall?.[1] as RequestInit | undefined)?.body),
    ) as { p_account?: Record<string, unknown> };
    expect(persistenceBody.p_account).toMatchObject({
      remote_account_id: "12345678901234567",
      username: "review-fixture",
    });
    expect(persistenceBody.p_account).not.toHaveProperty(
      "authorization_context",
    );
  });

  it.each([
    [
      "profile HTTP rejection",
      { profileStatus: 400 },
      "profile_read",
      "provider_http",
      400,
    ],
    [
      "profile network rejection",
      { profileNetworkFailure: true },
      "profile_read",
      "provider_network",
      undefined,
    ],
    [
      "token exchange HTTP rejection",
      { tokenExchangeStatus: 400 },
      "token_exchange",
      "provider_http",
      400,
    ],
    [
      "token exchange network rejection",
      { tokenExchangeNetworkFailure: true },
      "token_exchange",
      "provider_network",
      undefined,
    ],
    [
      "malformed profile",
      { profileBody: { id: "legacy-id", username: "review-fixture" } },
      "profile_read",
      "internal",
      undefined,
    ],
    [
      "database persistence rejection",
      { persistenceStatus: 500 },
      "account_persistence",
      "database",
      undefined,
    ],
    [
      "conflicting account rejection",
      { persistenceStatus: 409 },
      "account_persistence",
      "database",
      undefined,
    ],
  ] as const)(
    "turns %s into a sanitized browser redirect with no publication",
    async (_name, options, phase, classification, providerStatus) => {
      const fixture = await record();
      const { calls } = completionFetch(fixture, options);
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const response = await app.fetch(
        completionRequest({ token: jwt() }),
        environment,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://postline.example.test/accounts?oauth=error&platform=instagram",
      );
      expect(await response.text()).toBe("");
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("oauth_completion_failed");
      expect(logged).toContain(`"state":"${phase}"`);
      expect(logged).toContain(`"classification":"${classification}"`);
      if (providerStatus !== undefined)
        expect(logged).toContain(`"providerStatus":${providerStatus}`);
      else expect(logged).not.toContain("providerStatus");
      expect(logged).not.toContain("synthetic-code");
      expect(logged).not.toContain("synthetic-short-token");
      expect(logged).not.toContain("synthetic-long-token");
      expect(
        calls.some((url) => {
          const parsed = new URL(url);
          return /\/(media|media_publish)$/.test(parsed.pathname);
        }),
      ).toBe(false);
      if (
        options.profileStatus ||
        options.profileBody ||
        options.profileNetworkFailure ||
        options.tokenExchangeStatus ||
        options.tokenExchangeNetworkFailure
      ) {
        expect(
          calls.some((url) =>
            url.endsWith("/rest/v1/rpc/persist_bound_oauth_account"),
          ),
        ).toBe(false);
      }
      log.mockRestore();
    },
  );

  it("does not repeat provider exchange after a failed consumed completion", async () => {
    const fixture = await record();
    const { calls } = completionFetch(fixture, { profileStatus: 400 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await app.fetch(
      completionRequest({ token: jwt() }),
      environment,
    );
    const replay = await app.fetch(
      completionRequest({ token: jwt() }),
      environment,
    );
    expect(first.status).toBe(303);
    expect(replay.status).toBe(403);
    expect(
      calls.filter(
        (url) => url === "https://api.instagram.com/oauth/access_token",
      ),
    ).toHaveLength(1);
    log.mockRestore();
  });

  it.each([
    [
      "user B in the same browser",
      {
        userId: "44444444-4444-4444-8444-444444444444",
        email: "other@postline.dev",
      },
      jwt("44444444-4444-4444-8444-444444444445"),
    ],
    [
      "same user in a different Auth session",
      {},
      jwt("55555555-5555-4555-8555-555555555555"),
    ],
    ["invalid bearer", { authOk: false }, jwt()],
    ["expired bearer", {}, jwt(sessionId, Math.floor(Date.now() / 1_000) - 10)],
  ])("rejects %s before provider exchange", async (_name, options, token) => {
    const fixture = await record();
    const { calls } = completionFetch(fixture, options);
    const response = await app.fetch(completionRequest({ token }), environment);
    expect([401, 403]).toContain(response.status);
    expectNoProviderSideEffect(calls);
  });

  it("rejects a missing bearer before reading completion state", async () => {
    const fixture = await record();
    const { calls } = completionFetch(fixture);
    const response = await app.fetch(completionRequest({}), environment);
    expect(response.status).toBe(401);
    expectNoProviderSideEffect(calls);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["missing browser cookie", "", completion, false],
    [
      "wrong browser cookie",
      "wrong-browser-cookie-with-enough-random-bytes",
      completion,
      false,
    ],
    ["duplicate browser cookie", binding, completion, true],
    ["missing completion cookie", binding, "", false],
    [
      "wrong completion handle",
      binding,
      "wrong-completion-handle-with-enough-random-bytes",
      false,
    ],
  ])(
    "rejects %s without exchange or persistence",
    async (_name, browserCookie, completionCookie, duplicateBrowserCookie) => {
      const fixture = await record();
      const { calls } = completionFetch(fixture);
      const response = await app.fetch(
        completionRequest({
          token: jwt(),
          browserCookie,
          completionCookie,
          duplicateBrowserCookie,
        }),
        environment,
      );
      expect([400, 403]).toContain(response.status);
      expectNoProviderSideEffect(calls);
    },
  );

  it("rejects expired and replayed completion records", async () => {
    for (const [fixture, consume] of [
      [
        await record({
          expires_at: new Date(Date.now() - 1_000).toISOString(),
        }),
        true,
      ],
      [await record(), false],
    ] as const) {
      const { calls } = completionFetch(fixture, { consume });
      const response = await app.fetch(
        completionRequest({ token: jwt() }),
        environment,
      );
      expect([400, 403]).toContain(response.status);
      expectNoProviderSideEffect(calls);
    }
  });

  it("allows only one of two simultaneous completion attempts to exchange", async () => {
    const fixture = await record();
    const { calls } = completionFetch(fixture);
    const responses = await Promise.all([
      app.fetch(completionRequest({ token: jwt() }), environment),
      app.fetch(completionRequest({ token: jwt() }), environment),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      303, 403,
    ]);
    expect(
      calls.filter(
        (url) => url === "https://api.instagram.com/oauth/access_token",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.endsWith("/persist_bound_oauth_account")),
    ).toHaveLength(1);
  });

  it("accepts an access-token refresh only when the Auth session id is unchanged", async () => {
    const fixture = await record();
    const { calls } = completionFetch(fixture);
    const refreshedToken = jwt(
      sessionId,
      Math.floor(Date.now() / 1_000) + 1200,
    );
    expect(
      (
        await app.fetch(
          completionRequest({ token: refreshedToken }),
          environment,
        )
      ).status,
    ).toBe(303);
    expect(calls.some(isProviderRequest)).toBe(true);
  });

  it("rejects callback replay, duplicate parameters, and redirect mismatch before provider work", async () => {
    const cases = [
      {
        fixture: await record(),
        request: callbackRequest(
          binding,
          `code=one&code=two&state=${encodeURIComponent(state)}`,
        ),
        recordCallback: true,
      },
      {
        fixture: await record({
          redirect_uri: "https://attacker.invalid/callback",
        }),
        request: callbackRequest(),
        recordCallback: true,
      },
      {
        fixture: await record(),
        request: callbackRequest(),
        recordCallback: false,
      },
    ];
    for (const item of cases) {
      const { calls } = callbackFetch(item.fixture, item.recordCallback);
      const response = await app.fetch(item.request, environment);
      expect([400, 403]).toContain(response.status);
      expectNoProviderSideEffect(calls);
    }
  });

  it.each([
    ["ban", { banned_until: "2099-01-01T00:00:00.000Z" }, undefined],
    ["deletion", null, undefined],
    ["rename", { email: "renamed@example.test" }, undefined],
    [
      "generation replacement",
      undefined,
      "66666666-6666-4666-8666-666666666666",
    ],
  ])(
    "rejects reviewer completion after %s",
    async (_name, reviewerAdmin, reviewerGeneration) => {
      const generation = "77777777-7777-4777-8777-777777777777";
      const reviewerId = "88888888-8888-4888-8888-888888888888";
      const reviewerEmail = "reviewer@postline.dev";
      const fixture = await record({
        owner_id: reviewerId,
        initiating_email: reviewerEmail,
        authorization_context: "meta_review",
        authorization_generation: generation,
      });
      const reviewEnvironment = {
        ...environment,
        META_REVIEW_MODE: "true",
        META_REVIEWER_USER_ID: reviewerId,
        META_REVIEWER_EMAIL: reviewerEmail,
      } as Env;
      const { calls } = completionFetch(fixture, {
        userId: reviewerId,
        email: reviewerEmail,
        reviewerAdmin:
          reviewerAdmin === undefined
            ? undefined
            : reviewerAdmin === null
              ? null
              : {
                  id: reviewerId,
                  email: reviewerEmail,
                  email_confirmed_at: new Date().toISOString(),
                  is_anonymous: false,
                  ...reviewerAdmin,
                },
        reviewerGeneration,
      });
      const response = await app.fetch(
        completionRequest({ token: jwt(sessionId, undefined, true) }),
        reviewEnvironment,
      );
      expect(response.status).toBe(403);
      expectNoProviderSideEffect(calls);
    },
  );

  it("rejects reviewer UUID replacement and review-mode disablement", async () => {
    const generation = "77777777-7777-4777-8777-777777777777";
    const fixture = await record({
      owner_id: "88888888-8888-4888-8888-888888888888",
      initiating_email: "reviewer@postline.dev",
      authorization_context: "meta_review",
      authorization_generation: generation,
    });
    for (const reviewEnvironment of [
      {
        ...environment,
        META_REVIEW_MODE: "true",
        META_REVIEWER_USER_ID: "99999999-9999-4999-8999-999999999999",
        META_REVIEWER_EMAIL: "reviewer@postline.dev",
      },
      {
        ...environment,
        META_REVIEW_MODE: "false",
        META_REVIEWER_USER_ID: fixture.owner_id,
        META_REVIEWER_EMAIL: fixture.initiating_email,
      },
    ] as Env[]) {
      const { calls } = completionFetch(fixture, {
        userId: String(reviewEnvironment.META_REVIEWER_USER_ID),
        email: "reviewer@postline.dev",
        reviewerGeneration: generation,
      });
      const response = await app.fetch(
        completionRequest({ token: jwt(sessionId, undefined, true) }),
        reviewEnvironment,
      );
      expect(response.status).toBe(403);
      expectNoProviderSideEffect(calls);
    }
  });

  it("starts with a session-bound HttpOnly Lax cookie and never puts the bearer in a URL", async () => {
    const token = jwt();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/auth/v1/user"))
          return Response.json({ id: ownerId, email: "owner@postline.dev" });
        if (url.endsWith("/rest/v1/rpc/consume_rate_limit"))
          return Response.json(true);
        if (url.endsWith("/rest/v1/oauth_states")) return Response.json([]);
        throw new Error("unexpected request");
      }),
    );
    const response = await app.request(
      "https://worker.example.test/api/oauth/instagram/start",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      environment,
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(calls.every((url) => !url.includes(token))).toBe(true);
  });

  it("cancels only the authenticated exact session and clears every OAuth cookie", async () => {
    const token = jwt();
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({
          url,
          body: typeof init.body === "string" ? init.body : undefined,
        });
        if (url.endsWith("/auth/v1/user"))
          return Response.json({ id: ownerId, email: "owner@postline.dev" });
        if (url.endsWith("/rest/v1/rpc/cancel_pending_oauth"))
          return Response.json(1);
        throw new Error("unexpected request");
      }),
    );
    const response = await app.request(
      "https://worker.example.test/api/oauth/cancel",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      environment,
    );
    expect(response.status).toBe(200);
    const rpcCall = calls.find(({ url }) =>
      url.endsWith("/cancel_pending_oauth"),
    );
    expect(JSON.parse(rpcCall!.body!)).toEqual({
      p_owner_id: ownerId,
      p_auth_session_id: sessionId,
    });
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies.match(/Max-Age=0/g)?.length).toBe(6);
  });
});

describe("strict OAuth cookie parsing", () => {
  it("rejects duplicate, malformed, and oversized cookie input", () => {
    expect(
      readSingleCookie(
        new Request("https://worker.test", {
          headers: { Cookie: "target=one; target=two" },
        }),
        "target",
      ),
    ).toBeNull();
    expect(
      readSingleCookie(
        new Request("https://worker.test", {
          headers: { Cookie: `target=${"a".repeat(4097)}` },
        }),
        "target",
      ),
    ).toBeNull();
    expect(
      readSingleCookie(
        new Request("https://worker.test", {
          headers: { Cookie: "other=value; target=one" },
        }),
        "target",
      ),
    ).toBe("one");
  });
});
