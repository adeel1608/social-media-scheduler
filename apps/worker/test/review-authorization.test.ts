import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { requireReviewerAuthorization } from "../src/review-authorization";

const reviewerId = "22222222-2222-4222-8222-222222222222";
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const environment = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  META_REVIEW_MODE: "true",
  META_REVIEWER_USER_ID: reviewerId,
  META_REVIEWER_EMAIL: "reviewer@postline.dev",
} as Env;

function fetcher(
  user: Record<string, unknown> | null,
  grant: unknown = { generation },
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/admin/users/"))
      return user ? Response.json(user) : new Response(null, { status: 503 });
    if (url.endsWith("/rest/v1/rpc/current_meta_review_authorization"))
      return Response.json(grant);
    throw new Error("unexpected request");
  });
}
const currentUser = () => ({
  id: reviewerId,
  email: "reviewer@postline.dev",
  email_confirmed_at: new Date().toISOString(),
  banned_until: null,
});

describe("authoritative reviewer lifecycle", () => {
  it("accepts only the current Auth identity and durable generation", async () => {
    await expect(
      requireReviewerAuthorization(
        environment,
        reviewerId,
        generation,
        fetcher(currentUser()),
      ),
    ).resolves.toBe(generation);
  });
  it.each([
    [
      "ban",
      {
        ...currentUser(),
        banned_until: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    ["delete", { ...currentUser(), deleted_at: new Date().toISOString() }],
    ["rename", { ...currentUser(), email: "renamed@postline.dev" }],
    ["disable", { ...currentUser(), email_confirmed_at: null }],
  ])("rejects an Auth %s", async (_name, user) => {
    await expect(
      requireReviewerAuthorization(
        environment,
        reviewerId,
        generation,
        fetcher(user),
      ),
    ).rejects.toThrow("Reviewer authorization");
  });
  it("rejects configuration UUID replacement before querying Auth", async () => {
    const request = fetcher(currentUser());
    await expect(
      requireReviewerAuthorization(
        {
          ...environment,
          META_REVIEWER_USER_ID: "33333333-3333-4333-8333-333333333333",
        },
        reviewerId,
        generation,
        request,
      ),
    ).rejects.toThrow("Reviewer authorization");
    expect(request).not.toHaveBeenCalled();
  });
  it("fails closed on Auth outage and generation revocation", async () => {
    await expect(
      requireReviewerAuthorization(
        environment,
        reviewerId,
        generation,
        fetcher(null),
      ),
    ).rejects.toThrow("Reviewer authorization");
    await expect(
      requireReviewerAuthorization(
        environment,
        reviewerId,
        generation,
        fetcher(currentUser(), null),
      ),
    ).rejects.toThrow("Reviewer authorization");
  });
});
