import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authenticateWorkspaceRequest } from "../../apps/worker/src/access";
import { requireReviewerAuthorization } from "../../apps/worker/src/review-authorization";
import type { Env } from "../../apps/worker/src/env";

const base = process.env.POSTLINE_TEST_SUPABASE_URL!;
const anonKey = process.env.POSTLINE_TEST_SUPABASE_ANON_KEY!;
const serviceKey = process.env.POSTLINE_TEST_SUPABASE_SERVICE_KEY!;
const ownerId = crypto.randomUUID();
const reviewerId = crypto.randomUUID();
const unrelatedId = crypto.randomUUID();
const suffix = crypto.randomUUID();
const ownerEmail = `owner-${suffix}@example.test`;
const reviewerEmail = `reviewer-${suffix}@example.test`;
const unrelatedEmail = `unrelated-${suffix}@example.test`;
const password = `Synthetic-${crypto.randomUUID()}-A1!`;
let ownerJwt = "";
let reviewerJwt = "";
let unrelatedJwt = "";
let generation = "";

const env = () =>
  ({
    SUPABASE_URL: base,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    OWNER_EMAIL: ownerEmail,
    META_REVIEW_MODE: "true",
    META_REVIEWER_USER_ID: reviewerId,
    META_REVIEWER_EMAIL: reviewerEmail,
  }) as Env;

async function api(
  path: string,
  init: RequestInit = {},
  token = serviceKey,
  apiKey = serviceKey,
) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}
async function json(
  path: string,
  init: RequestInit = {},
  token = serviceKey,
  apiKey = serviceKey,
) {
  const response = await api(path, init, token, apiKey);
  expect(
    response.ok,
    `local request ${path} failed with ${response.status}`,
  ).toBe(true);
  return response.status === 204 ? null : response.json();
}
async function createUser(id: string, email: string) {
  await json("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ id, email, password, email_confirm: true }),
  });
}
async function signIn(email: string) {
  const value = (await json(
    "/auth/v1/token?grant_type=password",
    { method: "POST", body: JSON.stringify({ email, password }) },
    anonKey,
    anonKey,
  )) as { access_token: string };
  return value.access_token;
}
async function rpc(
  name: string,
  args: unknown,
  token = serviceKey,
  apiKey = serviceKey,
) {
  return json(
    `/rest/v1/rpc/${name}`,
    { method: "POST", body: JSON.stringify(args) },
    token,
    apiKey,
  );
}

beforeAll(async () => {
  expect(base).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/);
  await createUser(ownerId, ownerEmail);
  await createUser(reviewerId, reviewerEmail);
  await createUser(unrelatedId, unrelatedEmail);
  await json("/rest/v1/installation_settings", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ owner_id: ownerId, owner_email: ownerEmail }),
  });
  generation = (await rpc("set_meta_review_authorization", {
    p_user_id: reviewerId,
    p_email: reviewerEmail,
    p_enabled: true,
    p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  })) as string;
  [ownerJwt, reviewerJwt, unrelatedJwt] = await Promise.all([
    signIn(ownerEmail),
    signIn(reviewerEmail),
    signIn(unrelatedEmail),
  ]);
});

afterAll(() => {
  ownerJwt = reviewerJwt = unrelatedJwt = generation = "";
});

describe.sequential("real disposable Auth and PostgREST", () => {
  it("accepts a real password reviewer JWT and rejects a real magic-link JWT", async () => {
    const passwordResult = await authenticateWorkspaceRequest(
      env(),
      new Request("http://local/api/session", {
        headers: { Authorization: `Bearer ${reviewerJwt}` },
      }),
    );
    expect(passwordResult).toMatchObject({
      authenticated: true,
      accessRole: "meta_reviewer",
      reviewGeneration: generation,
    });
    const link = (await json("/auth/v1/admin/generate_link", {
      method: "POST",
      body: JSON.stringify({ type: "magiclink", email: reviewerEmail }),
    })) as { hashed_token: string };
    const session = (await json(
      "/auth/v1/verify",
      {
        method: "POST",
        body: JSON.stringify({
          type: "magiclink",
          token_hash: link.hashed_token,
        }),
      },
      anonKey,
      anonKey,
    )) as { access_token: string };
    const magicResult = await authenticateWorkspaceRequest(
      env(),
      new Request("http://local/api/session", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }),
    );
    expect(magicResult).toMatchObject({ authenticated: false, status: 403 });
  });

  it("provides owner positive-control RLS while isolating reviewer and unrelated users", async () => {
    const ownerRows = (await json(
      "/rest/v1/installation_settings?select=owner_id",
      {},
      ownerJwt,
      anonKey,
    )) as unknown[];
    const reviewerRows = (await json(
      "/rest/v1/connected_accounts?select=id",
      {},
      reviewerJwt,
      anonKey,
    )) as unknown[];
    const unrelatedRows = (await json(
      "/rest/v1/posts?select=id",
      {},
      unrelatedJwt,
      anonKey,
    )) as unknown[];
    expect(ownerRows).toHaveLength(1);
    expect(reviewerRows).toHaveLength(0);
    expect(unrelatedRows).toHaveLength(0);
  });

  it("serializes owner/reviewer reservations under one application ceiling", async () => {
    const ownerReservation = rpc(
      "reserve_uploadthing_media",
      {
        p_original_filename: "owner.bin",
        p_mime_type: "application/octet-stream",
        p_size_bytes: 1_600_000_000,
        p_width: null,
        p_height: null,
        p_duration_seconds: null,
      },
      ownerJwt,
      anonKey,
    );
    const reviewReservation = rpc("reserve_meta_review_media", {
      p_reviewer_id: reviewerId,
      p_original_filename: "review.bin",
      p_mime_type: "application/octet-stream",
      p_size_bytes: 400_000_000,
      p_width: null,
      p_height: null,
      p_duration_seconds: null,
    });
    const results = await Promise.allSettled([
      ownerReservation,
      reviewReservation,
    ]);
    expect(
      results.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    const rows = (await json(
      `/rest/v1/media_assets?owner_id=in.(${ownerId},${reviewerId})&deleted_at=is.null&select=id,owner_id`,
      {},
    )) as Array<{ id: string; owner_id: string }>;
    expect(rows).toHaveLength(1);
    await json(`/rest/v1/media_assets?id=eq.${rows[0]!.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    });
    expect(
      await rpc("reserve_meta_review_media", {
        p_reviewer_id: reviewerId,
        p_original_filename: "released.bin",
        p_mime_type: "application/octet-stream",
        p_size_bytes: 1000,
        p_width: null,
        p_height: null,
        p_duration_seconds: null,
      }),
    ).toMatch(/[0-9a-f-]{36}/);
    const usage = (await rpc("meta_review_storage_usage", {
      p_reviewer_id: reviewerId,
    })) as Array<Record<string, unknown>>;
    expect(Object.keys(usage[0]!).sort()).toEqual([
      "active_bytes",
      "limit_bytes",
      "reserved_bytes",
    ]);
  });

  it("executes all four disconnect RPCs only through service-role PostgREST", async () => {
    const accountId = crypto.randomUUID();
    await json("/rest/v1/connected_accounts", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        id: accountId,
        owner_id: ownerId,
        platform: "youtube",
        remote_account_id: `remote-${suffix}`,
        encrypted_access_token: "cipher",
        access_token_nonce: "nonce",
        encryption_key_version: "v1",
      }),
    });
    const begun = (await rpc("begin_account_disconnect", {
      p_account_id: accountId,
      p_owner_id: ownerId,
    })) as Record<string, unknown>;
    const operation = begun.operation_id;
    expect(
      await rpc("mark_account_disconnect_revocation_started", {
        p_account_id: accountId,
        p_owner_id: ownerId,
        p_operation_id: operation,
      }),
    ).toMatchObject({ should_revoke: true });
    expect(
      await rpc("record_account_disconnect_revocation", {
        p_account_id: accountId,
        p_owner_id: ownerId,
        p_operation_id: operation,
        p_outcome: "provider_revoked",
      }),
    ).toMatchObject({ state: "provider_revoked" });
    expect(
      await rpc("complete_account_disconnect", {
        p_account_id: accountId,
        p_owner_id: ownerId,
        p_operation_id: operation,
        p_provider_confirmed: true,
      }),
    ).toMatchObject({ state: "completed" });
    for (const [name, args] of [
      [
        "begin_account_disconnect",
        { p_account_id: accountId, p_owner_id: ownerId },
      ],
      [
        "mark_account_disconnect_revocation_started",
        {
          p_account_id: accountId,
          p_owner_id: ownerId,
          p_operation_id: operation,
        },
      ],
      [
        "record_account_disconnect_revocation",
        {
          p_account_id: accountId,
          p_owner_id: ownerId,
          p_operation_id: operation,
          p_outcome: "provider_revoked",
        },
      ],
      [
        "complete_account_disconnect",
        {
          p_account_id: accountId,
          p_owner_id: ownerId,
          p_operation_id: operation,
          p_provider_confirmed: true,
        },
      ],
    ] as const) {
      const anonymous = await api(
        `/rest/v1/rpc/${name}`,
        { method: "POST", body: JSON.stringify(args) },
        anonKey,
        anonKey,
      );
      const authenticated = await api(
        `/rest/v1/rpc/${name}`,
        { method: "POST", body: JSON.stringify(args) },
        reviewerJwt,
        anonKey,
      );
      expect(anonymous.ok).toBe(false);
      expect(authenticated.ok).toBe(false);
    }
  });

  it("revokes queued authority when the current Auth user is banned", async () => {
    await json(`/auth/v1/admin/users/${reviewerId}`, {
      method: "PUT",
      body: JSON.stringify({ ban_duration: "876000h" }),
    });
    await expect(
      requireReviewerAuthorization(env(), reviewerId, generation),
    ).rejects.toThrow("Reviewer authorization");
    expect(
      await rpc("current_meta_review_authorization", {
        p_user_id: reviewerId,
        p_email: reviewerEmail,
      }),
    ).toBeNull();
    await json(`/auth/v1/admin/users/${reviewerId}`, {
      method: "PUT",
      body: JSON.stringify({ ban_duration: "none" }),
    });
    generation = (await rpc("set_meta_review_authorization", {
      p_user_id: reviewerId,
      p_email: reviewerEmail,
      p_enabled: true,
      p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })) as string;
    const renamedEmail = `renamed-${suffix}@example.test`;
    await json(`/auth/v1/admin/users/${reviewerId}`, {
      method: "PUT",
      body: JSON.stringify({ email: renamedEmail, email_confirm: true }),
    });
    expect(
      await rpc("current_meta_review_authorization", {
        p_user_id: reviewerId,
        p_email: reviewerEmail,
      }),
    ).toBeNull();

    const replacementId = crypto.randomUUID();
    const replacementEmail = `replacement-${suffix}@example.test`;
    await createUser(replacementId, replacementEmail);
    await rpc("set_meta_review_authorization", {
      p_user_id: replacementId,
      p_email: replacementEmail,
      p_enabled: true,
      p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await json(`/auth/v1/admin/users/${replacementId}`, { method: "DELETE" });
    expect(
      await rpc("current_meta_review_authorization", {
        p_user_id: replacementId,
        p_email: replacementEmail,
      }),
    ).toBeNull();
  });
});
