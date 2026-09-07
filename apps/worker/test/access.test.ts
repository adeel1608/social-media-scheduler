import { describe, expect, it, vi } from "vitest";

import {
  authenticateOwnerRequest,
  authenticateWorkspaceRequest,
  metaReviewTargetAuthorized,
  reviewerRouteAllowed,
} from "../src/auth";
import type { Env } from "../src/env";

const ownerId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "public-key",
    OWNER_EMAIL: "owner@postline.dev",
    META_REVIEW_MODE: "true",
    META_REVIEWER_EMAIL: "reviewer@postline.dev",
    META_REVIEWER_USER_ID: reviewerId,
    ...overrides,
  } as Env;
}

function request(authenticationMethod = "password") {
  const payload = btoa(
    JSON.stringify({
      amr: [{ method: authenticationMethod, timestamp: 1_788_000_000 }],
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return new Request("https://worker.example.test/api/session", {
    headers: { Authorization: `Bearer header.${payload}.signature` },
  });
}

function userResponse(id: string, email: string) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/admin/users/"))
      return Response.json({
        id,
        email,
        email_confirmed_at: new Date().toISOString(),
        banned_until: null,
      });
    if (url.endsWith("/rest/v1/rpc/current_meta_review_authorization"))
      return Response.json({ generation });
    return Response.json({
      id,
      email,
      exp: Math.floor(Date.now() / 1_000) + 600,
    });
  });
}

describe("workspace authentication", () => {
  it("preserves owner access independently of review mode", async () => {
    await expect(
      authenticateWorkspaceRequest(
        env({ META_REVIEW_MODE: "false" }),
        request(),
        userResponse(ownerId, "owner@postline.dev"),
      ),
    ).resolves.toMatchObject({ authenticated: true, accessRole: "owner" });
  });

  it("requires the exact reviewer JWT UUID and normalized email", async () => {
    await expect(
      authenticateWorkspaceRequest(
        env(),
        request(),
        userResponse(reviewerId, "reviewer@postline.dev"),
      ),
    ).resolves.toMatchObject({
      authenticated: true,
      accessRole: "meta_reviewer",
      reviewGeneration: generation,
    });

    for (const [id, email] of [
      [ownerId, "reviewer@postline.dev"],
      [reviewerId, "unlisted@postline.dev"],
    ]) {
      await expect(
        authenticateWorkspaceRequest(env(), request(), userResponse(id, email)),
      ).resolves.toEqual({
        authenticated: false,
        error: "access_denied",
        status: 403,
      });
    }
  });

  it("rejects reviewer sessions when mode is disabled or incomplete", async () => {
    for (const environment of [
      env({ META_REVIEW_MODE: "false" }),
      env({ META_REVIEWER_USER_ID: "" }),
    ]) {
      await expect(
        authenticateWorkspaceRequest(
          environment,
          request(),
          userResponse(reviewerId, "reviewer@postline.dev"),
        ),
      ).resolves.toMatchObject({ authenticated: false, status: 403 });
    }
  });

  it("requires password authentication for the reviewer but not the owner", async () => {
    await expect(
      authenticateWorkspaceRequest(
        env(),
        request("magiclink"),
        userResponse(reviewerId, "reviewer@postline.dev"),
      ),
    ).resolves.toEqual({
      authenticated: false,
      error: "access_denied",
      status: 403,
    });
    await expect(
      authenticateWorkspaceRequest(
        env(),
        request("magiclink"),
        userResponse(ownerId, "owner@postline.dev"),
      ),
    ).resolves.toMatchObject({ authenticated: true, accessRole: "owner" });
  });

  it("never accepts the reviewer as the installation owner", async () => {
    await expect(
      authenticateOwnerRequest(
        env(),
        request(),
        userResponse(reviewerId, "reviewer@postline.dev"),
      ),
    ).resolves.toEqual({
      authenticated: false,
      error: "access_denied",
      status: 403,
    });
  });
});

describe("reviewer capability boundaries", () => {
  it("uses a default-deny route allowlist", () => {
    expect(reviewerRouteAllowed("GET", "/api/accounts")).toBe(true);
    expect(reviewerRouteAllowed("POST", "/api/posts")).toBe(true);
    expect(reviewerRouteAllowed("POST", "/api/oauth/youtube/start")).toBe(
      false,
    );
    expect(reviewerRouteAllowed("GET", "/api/export")).toBe(false);
    expect(reviewerRouteAllowed("POST", "/api/installation/delete")).toBe(
      false,
    );
    expect(reviewerRouteAllowed("DELETE", "/api/accounts/not-a-uuid")).toBe(
      false,
    );
  });

  it("authorizes only a fully owner-matched Instagram review target", () => {
    const target = {
      authorization_context: "meta_review",
      owner_id: reviewerId,
      platform: "instagram",
      connected_accounts: {
        owner_id: reviewerId,
        platform: "instagram",
        authorization_context: "meta_review",
        connection_status: "connected",
      },
      posts: {
        owner_id: reviewerId,
        post_media: [{ media_assets: { owner_id: reviewerId } }],
      },
    };
    expect(metaReviewTargetAuthorized(env(), target)).toBe(true);
    expect(
      metaReviewTargetAuthorized(env(), {
        ...target,
        connected_accounts: {
          ...target.connected_accounts,
          owner_id: ownerId,
        },
      }),
    ).toBe(false);
    expect(
      metaReviewTargetAuthorized(env(), { ...target, platform: "youtube" }),
    ).toBe(false);
    expect(
      metaReviewTargetAuthorized(env(), {
        ...target,
        posts: {
          ...target.posts,
          post_media: [{ media_assets: { owner_id: ownerId } }],
        },
      }),
    ).toBe(false);
    expect(
      metaReviewTargetAuthorized(env({ META_REVIEW_MODE: "false" }), target),
    ).toBe(false);
  });
});
