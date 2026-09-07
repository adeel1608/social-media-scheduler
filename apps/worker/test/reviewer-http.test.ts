import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";
import { oauthStateAuthorizationValid } from "../src/oauth-routes";

const reviewerId = "22222222-2222-4222-8222-222222222222";
const ownerId = "11111111-1111-4111-8111-111111111111";
const passwordPayload = btoa(
  JSON.stringify({
    amr: [{ method: "password", timestamp: 1_788_000_000 }],
  }),
)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const reviewerSession = `header.${passwordPayload}.signature`;

const environment = {
  ENVIRONMENT: "development",
  APP_URL: "https://postline.example.test",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "public-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  OWNER_EMAIL: "owner@postline.dev",
  META_REVIEW_MODE: "true",
  META_REVIEWER_EMAIL: "reviewer@postline.dev",
  META_REVIEWER_USER_ID: reviewerId,
} as Env;

afterEach(() => vi.unstubAllGlobals());

function reviewerFetch(databaseRows: unknown[] = []) {
  const databaseUrls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({
        id: reviewerId,
        email: "reviewer@postline.dev",
        exp: Math.floor(Date.now() / 1_000) + 600,
      });
    }
    databaseUrls.push(url);
    return Response.json(databaseRows);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, databaseUrls };
}

function apiRequest(path: string, method = "GET") {
  return app.request(
    `https://worker.example.test${path}`,
    { method, headers: { Authorization: `Bearer ${reviewerSession}` } },
    environment,
  );
}

function containsInstagramGraphRequest(urls: readonly string[]): boolean {
  return urls.some((value) => {
    try {
      return new URL(value).hostname === "graph.instagram.com";
    } catch {
      return false;
    }
  });
}

describe("Meta reviewer HTTP isolation", () => {
  it("returns only the non-sensitive server-derived reviewer role", async () => {
    reviewerFetch();
    const response = await apiRequest("/api/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      role: "meta_reviewer",
      metaReview: true,
    });
  });

  it("scopes account reads by reviewer UUID, Instagram, and durable context", async () => {
    const { databaseUrls } = reviewerFetch();
    const response = await apiRequest("/api/accounts");
    expect(response.status).toBe(200);
    expect(databaseUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`owner_id=eq.${reviewerId}`),
      ]),
    );
    expect(
      databaseUrls.some((url) => url.includes("platform=eq.instagram")),
    ).toBe(true);
    expect(
      databaseUrls.some((url) =>
        url.includes("authorization_context=eq.meta_review"),
      ),
    ).toBe(true);
  });

  it("cannot disconnect a guessed owner account ID", async () => {
    const { databaseUrls } = reviewerFetch();
    const response = await apiRequest(`/api/accounts/${ownerId}`, "DELETE");
    expect(response.status).toBe(404);
    expect(databaseUrls[0]).toContain(`owner_id=eq.${reviewerId}`);
    expect(databaseUrls[0]).toContain("platform=eq.instagram");
    expect(databaseUrls[0]).toContain("authorization_context=eq.meta_review");
  });

  it("scopes every guessed target and media ID before using service access", async () => {
    const target = reviewerFetch();
    const cancelResponse = await apiRequest(
      `/api/targets/${ownerId}/cancel`,
      "PATCH",
    );
    expect(cancelResponse.status).toBe(409);
    expect(target.databaseUrls[0]).toContain(`owner_id=eq.${reviewerId}`);
    expect(target.databaseUrls[0]).toContain("platform=eq.instagram");
    expect(target.databaseUrls[0]).toContain(
      "authorization_context=eq.meta_review",
    );
    expect(target.databaseUrls[0]).toContain("publish_request_sent_at=is.null");

    vi.unstubAllGlobals();
    const media = reviewerFetch();
    const mediaResponse = await apiRequest(`/api/media/${ownerId}`, "DELETE");
    expect(mediaResponse.status).toBe(404);
    expect(media.databaseUrls[0]).toContain(`owner_id=eq.${reviewerId}`);

    vi.unstubAllGlobals();
    const analytics = reviewerFetch();
    const analyticsResponse = await apiRequest(`/api/analytics/${ownerId}`);
    expect(analyticsResponse.status).toBe(200);
    expect(analytics.databaseUrls[0]).toContain(`owner_id=eq.${reviewerId}`);
    expect(analytics.databaseUrls[0]).toContain("platform=eq.instagram");
    expect(analytics.databaseUrls[0]).toContain(
      "post_targets.authorization_context=eq.meta_review",
    );
  });

  it("never returns encrypted account credentials or provider tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/v1/user")) {
          return Response.json({
            id: reviewerId,
            email: "reviewer@postline.dev",
            exp: Math.floor(Date.now() / 1_000) + 600,
          });
        }
        if (url.includes("/rest/v1/connected_accounts?")) {
          return Response.json([
            {
              id: "33333333-3333-4333-8333-333333333333",
              platform: "instagram",
              username: "review_account",
              connection_status: "connected",
              approval_state: "pending",
              metadata: { displayName: "Review account" },
              encrypted_access_token: "must-not-be-returned",
              access_token_nonce: "must-not-be-returned",
              remote_account_id: "must-not-be-returned",
            },
          ]);
        }
        return Response.json([]);
      }),
    );

    const response = await apiRequest("/api/accounts");
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(body).toContain("review_account");
    expect(body).not.toContain("must-not-be-returned");
    expect(body).not.toContain("encrypted_access_token");
    expect(body).not.toContain("remote_account_id");
  });

  it("denies owner-only exports and non-Instagram OAuth before a database call", async () => {
    const first = reviewerFetch();
    expect((await apiRequest("/api/export")).status).toBe(403);
    expect(first.databaseUrls).toEqual([]);

    vi.unstubAllGlobals();
    const second = reviewerFetch();
    expect((await apiRequest("/api/oauth/youtube/start", "POST")).status).toBe(
      403,
    );
    expect(second.databaseUrls).toEqual([]);
  });
});

describe("reviewer OAuth state binding", () => {
  it("requires current mode, exact reviewer UUID, and Instagram", () => {
    const state = {
      owner_id: reviewerId,
      authorization_context: "meta_review",
    };
    expect(oauthStateAuthorizationValid(environment, "instagram", state)).toBe(
      true,
    );
    expect(oauthStateAuthorizationValid(environment, "youtube", state)).toBe(
      false,
    );
    expect(
      oauthStateAuthorizationValid(environment, "instagram", {
        ...state,
        owner_id: ownerId,
      }),
    ).toBe(false);
    expect(
      oauthStateAuthorizationValid(
        { ...environment, META_REVIEW_MODE: "false" },
        "instagram",
        state,
      ),
    ).toBe(false);
  });

  it("rejects unknown contexts without weakening existing owner state", () => {
    expect(
      oauthStateAuthorizationValid(environment, "instagram", {
        owner_id: ownerId,
        authorization_context: "owner",
      }),
    ).toBe(true);
    expect(
      oauthStateAuthorizationValid(environment, "instagram", {
        owner_id: reviewerId,
        authorization_context: "unknown",
      }),
    ).toBe(false);
  });

  it("rejects a replay before decrypting state or contacting Meta", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        if (
          url.includes("/rest/v1/oauth_states?") &&
          init?.method !== "PATCH"
        ) {
          return Response.json([
            {
              id: "33333333-3333-4333-8333-333333333333",
              owner_id: reviewerId,
              authorization_context: "meta_review",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ]);
        }
        if (
          url.includes("/rest/v1/oauth_states?") &&
          init?.method === "PATCH"
        ) {
          return Response.json([]);
        }
        throw new Error("unexpected external request");
      }),
    );

    const response = await app.request(
      "https://worker.example.test/api/oauth/instagram/callback?code=one-time-code&state=one-time-state",
      undefined,
      environment,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "oauth_state_already_consumed",
    });
    expect(containsInstagramGraphRequest(urls)).toBe(false);
  });

  it("consumes then rejects reviewer state when review mode is disabled", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        if (
          url.includes("/rest/v1/oauth_states?") &&
          init?.method !== "PATCH"
        ) {
          return Response.json([
            {
              id: "33333333-3333-4333-8333-333333333333",
              owner_id: reviewerId,
              authorization_context: "meta_review",
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ]);
        }
        if (
          url.includes("/rest/v1/oauth_states?") &&
          init?.method === "PATCH"
        ) {
          return Response.json([{}]);
        }
        throw new Error("unexpected external request");
      }),
    );

    const response = await app.request(
      "https://worker.example.test/api/oauth/instagram/callback?code=one-time-code&state=one-time-state",
      undefined,
      { ...environment, META_REVIEW_MODE: "false" },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "reviewer_oauth_not_authorized",
    });
    expect(containsInstagramGraphRequest(urls)).toBe(false);
  });
});
