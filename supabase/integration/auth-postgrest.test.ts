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
const ownerEmail = `owner-${suffix}@example.com`;
const reviewerEmail = `reviewer-${suffix}@example.com`;
const unrelatedEmail = `unrelated-${suffix}@example.com`;
const password = `Synthetic-${crypto.randomUUID()}-A1!`;
let ownerJwt = "";
let reviewerJwt = "";
let unrelatedJwt = "";
let generation = "";

const env = (
  review: { userId: string; email: string; enabled?: boolean } = {
    userId: reviewerId,
    email: reviewerEmail,
  },
) =>
  ({
    SUPABASE_URL: base,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    OWNER_EMAIL: ownerEmail,
    META_REVIEW_MODE: review.enabled === false ? "false" : "true",
    META_REVIEWER_USER_ID: review.userId,
    META_REVIEWER_EMAIL: review.email,
  }) as Env;

function authSessionId(token: string): string {
  const encoded = token.split(".")[1]!;
  const payload = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as { session_id: string };
  return payload.session_id;
}

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
  const text = await response.text();
  if (!response.ok) {
    let errorCode = "unknown";
    try {
      const error = JSON.parse(text) as {
        code?: unknown;
        error_code?: unknown;
      };
      const candidate = error.error_code ?? error.code;
      if (
        typeof candidate === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/i.test(candidate)
      ) {
        errorCode = candidate;
      }
    } catch {
      // Do not echo response bodies: Auth errors can include submitted identity data.
    }
    throw new Error(
      `local request ${path} failed with ${response.status} (${errorCode})`,
    );
  }
  return text ? JSON.parse(text) : null;
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
  ownerJwt = await signIn(ownerEmail);
  reviewerJwt = await signIn(reviewerEmail);
  unrelatedJwt = await signIn(unrelatedEmail);
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

  it("enforces the media authorization matrix through real PostgREST", async () => {
    const ownerMediaId = (await rpc(
      "reserve_uploadthing_media",
      {
        p_original_filename: "owner-matrix.bin",
        p_mime_type: "application/octet-stream",
        p_size_bytes: 4096,
        p_width: null,
        p_height: null,
        p_duration_seconds: null,
      },
      ownerJwt,
      anonKey,
    )) as string;
    const reviewerMediaId = (await rpc("reserve_meta_review_media", {
      p_reviewer_id: reviewerId,
      p_original_filename: "review-matrix.bin",
      p_mime_type: "application/octet-stream",
      p_size_bytes: 4096,
      p_width: null,
      p_height: null,
      p_duration_seconds: null,
    })) as string;
    for (const [mediaId, mediaOwner, key] of [
      [ownerMediaId, ownerId, `owner-${suffix}`],
      [reviewerMediaId, reviewerId, `review-${suffix}`],
    ] as const) {
      expect(
        await rpc("complete_uploadthing_media", {
          p_media_id: mediaId,
          p_owner_id: mediaOwner,
          p_provider_file_key: key,
          p_provider_url: `https://fixture.ufs.sh/f/${key}`,
          p_size_bytes: 4096,
          p_mime_type: "application/octet-stream",
          p_checksum_sha256: null,
        }),
      ).toBe("completed");
    }

    const ownerRead = (await json(
      `/rest/v1/media_assets?id=in.(${ownerMediaId},${reviewerMediaId})&select=id,owner_id,size_bytes`,
      {},
      ownerJwt,
      anonKey,
    )) as Array<Record<string, unknown>>;
    expect(ownerRead).toEqual([
      expect.objectContaining({ id: ownerMediaId, owner_id: ownerId }),
    ]);
    expect(
      await json(
        `/rest/v1/media_assets?id=in.(${ownerMediaId},${reviewerMediaId})&select=id`,
        {},
        reviewerJwt,
        anonKey,
      ),
    ).toEqual([]);
    expect(
      await json(
        `/rest/v1/media_assets?id=in.(${ownerMediaId},${reviewerMediaId})&select=id`,
        {},
        unrelatedJwt,
        anonKey,
      ),
    ).toEqual([]);

    const identities = [
      ["owner", ownerJwt, anonKey],
      ["reviewer", reviewerJwt, anonKey],
      ["unrelated", unrelatedJwt, anonKey],
      ["anon", anonKey, anonKey],
    ] as const;
    for (const [_identity, token, key] of identities) {
      const insert = await api(
        "/rest/v1/media_assets",
        {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            owner_id: ownerId,
            object_key: crypto.randomUUID(),
            original_filename: "bypass.bin",
            mime_type: "application/octet-stream",
            size_bytes: 1,
            upload_status: "uploading",
            storage_provider: "uploadthing",
          }),
        },
        token,
        key,
      );
      expect(insert.ok).toBe(false);
    }

    for (const mutation of [
      { size_bytes: 1 },
      { size_bytes: 999_999_999 },
      { owner_id: unrelatedId },
      { authorization_context: "meta_review" },
      { authorization_generation: generation },
      { provider_file_key: "attacker-key", object_key: "attacker-key" },
      { upload_status: "uploading", reservation_expires_at: null },
      { deleted_at: new Date().toISOString() },
      { deleted_at: null, deletion_status: "not_requested" },
    ]) {
      const response = await api(
        `/rest/v1/media_assets?id=eq.${ownerMediaId}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(mutation),
        },
        ownerJwt,
        anonKey,
      );
      expect(response.ok).toBe(false);
    }
    for (const [_identity, token, key] of identities.slice(1)) {
      for (const mutation of [
        { size_bytes: 1 },
        { provider_file_key: "cross-identity-key" },
        { upload_status: "deleted", deleted_at: new Date().toISOString() },
      ]) {
        expect(
          (
            await api(
              `/rest/v1/media_assets?id=eq.${ownerMediaId}`,
              {
                method: "PATCH",
                headers: { Prefer: "return=minimal" },
                body: JSON.stringify(mutation),
              },
              token,
              key,
            )
          ).ok,
        ).toBe(false);
      }
      expect(
        (
          await api(
            `/rest/v1/media_assets?id=eq.${ownerMediaId}`,
            { method: "DELETE" },
            token,
            key,
          )
        ).ok,
      ).toBe(false);
    }
    expect(
      (
        await api(
          `/rest/v1/media_assets?id=eq.${ownerMediaId}`,
          { method: "DELETE" },
          ownerJwt,
          anonKey,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await api(
          "/rest/v1/media_assets?on_conflict=id",
          {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              id: ownerMediaId,
              owner_id: ownerId,
              object_key: `upsert-${suffix}`,
              original_filename: "upsert.bin",
              mime_type: "application/octet-stream",
              size_bytes: 1,
              upload_status: "uploading",
              storage_provider: "uploadthing",
            }),
          },
          ownerJwt,
          anonKey,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await api(
          "/rest/v1/rpc/update_media_asset",
          { method: "POST", body: "{}" },
          ownerJwt,
          anonKey,
        )
      ).ok,
    ).toBe(false);

    const beforeCleanup = (await json(
      `/rest/v1/media_assets?id=eq.${ownerMediaId}&select=size_bytes,deleted_at,deletion_status`,
    )) as Array<Record<string, unknown>>;
    expect(beforeCleanup).toEqual([
      {
        size_bytes: 4096,
        deleted_at: null,
        deletion_status: "not_requested",
      },
    ]);
    await json(`/rest/v1/media_assets?id=eq.${ownerMediaId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        deletion_status: "confirmed",
        provider_deleted_at: new Date().toISOString(),
        deleted_at: new Date().toISOString(),
        upload_status: "deleted",
      }),
    });
    expect(
      await json(
        `/rest/v1/media_assets?id=eq.${reviewerMediaId}&authorization_generation=eq.${generation}&select=id,provider_file_key,upload_status`,
      ),
    ).toEqual([
      {
        id: reviewerMediaId,
        provider_file_key: `review-${suffix}`,
        upload_status: "complete",
      },
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
    const renamedEmail = `renamed-${suffix}@example.com`;
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
    const replacementEmail = `replacement-${suffix}@example.com`;
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

  it("does not transfer reviewer authority to a replacement UUID with the same email", async () => {
    const oldId = crypto.randomUUID();
    const replacementId = crypto.randomUUID();
    const reviewEmail = `uuid-replacement-${suffix}@example.com`;
    await createUser(oldId, reviewEmail);
    const oldGeneration = (await rpc("set_meta_review_authorization", {
      p_user_id: oldId,
      p_email: reviewEmail,
      p_enabled: true,
      p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })) as string;
    const oldJwt = await signIn(reviewEmail);
    const oldSessionId = authSessionId(oldJwt);
    const accountId = crypto.randomUUID();
    await json("/rest/v1/connected_accounts", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        id: accountId,
        owner_id: oldId,
        platform: "instagram",
        remote_account_id: `uuid-old-${suffix}`,
        encrypted_access_token: "cipher",
        access_token_nonce: "nonce",
        encryption_key_version: "v1",
        connection_status: "connected",
        authorization_context: "meta_review",
        authorization_generation: oldGeneration,
      }),
    });
    const mediaId = (await rpc("reserve_meta_review_media", {
      p_reviewer_id: oldId,
      p_original_filename: "uuid-old.bin",
      p_mime_type: "application/octet-stream",
      p_size_bytes: 1024,
      p_width: null,
      p_height: null,
      p_duration_seconds: null,
    })) as string;
    const mediaKey = `uuid-old-media-${suffix}`;
    expect(
      await rpc("complete_uploadthing_media", {
        p_media_id: mediaId,
        p_owner_id: oldId,
        p_provider_file_key: mediaKey,
        p_provider_url: `https://fixture.ufs.sh/f/${mediaKey}`,
        p_size_bytes: 1024,
        p_mime_type: "application/octet-stream",
        p_checksum_sha256: null,
      }),
    ).toBe("completed");
    const postId = (await rpc("create_meta_review_post", {
      p_reviewer_id: oldId,
      p_title: "Old reviewer work",
      p_base_caption: "",
      p_scheduled_at_utc: new Date(Date.now() + 60_000).toISOString(),
      p_media_ids: [mediaId],
      p_connected_account_id: accountId,
      p_selected_media_ids: [mediaId],
      p_metadata: { contentType: "feed_image" },
    })) as string;
    const stateHash = "b".repeat(64);
    const completionHash = "c".repeat(64);
    await json("/rest/v1/oauth_states", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        owner_id: oldId,
        platform: "instagram",
        state_hash: stateHash,
        redirect_uri:
          "https://worker.example.test/api/oauth/instagram/callback",
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        consumed_at: new Date().toISOString(),
        callback_received_at: new Date().toISOString(),
        encrypted_pkce_verifier: "pkce-cipher",
        pkce_nonce: "pkce-nonce",
        authorization_context: "meta_review",
        authorization_generation: oldGeneration,
        browser_binding_hash: "d".repeat(64),
        auth_session_id: oldSessionId,
        initiating_email: reviewEmail,
        pending_authorization_code: "encrypted-authorization-code",
        pending_authorization_code_nonce: "code-nonce-value",
        pending_authorization_code_key_version: "v1",
        pending_completion_handle_hash: completionHash,
      }),
    });

    const renamedEmail = `old-renamed-${suffix}@example.com`;
    await json(`/auth/v1/admin/users/${oldId}`, {
      method: "PUT",
      body: JSON.stringify({ email: renamedEmail, email_confirm: true }),
    });
    await createUser(replacementId, reviewEmail);
    const replacementJwt = await signIn(reviewEmail);
    const replacementSessionId = authSessionId(replacementJwt);
    const replacementEnvironment = env({
      userId: replacementId,
      email: reviewEmail,
    });
    expect(
      await authenticateWorkspaceRequest(
        replacementEnvironment,
        new Request("http://local/api/session", {
          headers: { Authorization: `Bearer ${replacementJwt}` },
        }),
      ),
    ).toMatchObject({ authenticated: false, status: 403 });

    const replacementGeneration = (await rpc("set_meta_review_authorization", {
      p_user_id: replacementId,
      p_email: reviewEmail,
      p_enabled: true,
      p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })) as string;
    expect(replacementGeneration).not.toBe(oldGeneration);
    expect(
      await authenticateWorkspaceRequest(
        replacementEnvironment,
        new Request("http://local/api/session", {
          headers: { Authorization: `Bearer ${replacementJwt}` },
        }),
      ),
    ).toMatchObject({
      authenticated: true,
      accessRole: "meta_reviewer",
      reviewGeneration: replacementGeneration,
    });
    expect(
      await json(
        `/rest/v1/media_assets?id=eq.${mediaId}&select=id`,
        {},
        replacementJwt,
        anonKey,
      ),
    ).toEqual([]);
    expect(
      await rpc("consume_oauth_completion", {
        p_completion_handle_hash: completionHash,
        p_browser_binding_hash: "d".repeat(64),
        p_platform: "instagram",
        p_current_owner_id: replacementId,
        p_current_email: reviewEmail,
        p_current_auth_session_id: replacementSessionId,
        p_owner_email: ownerEmail,
        p_review_enabled: true,
        p_reviewer_id: replacementId,
        p_reviewer_email: reviewEmail,
        p_redirect_uri:
          "https://worker.example.test/api/oauth/instagram/callback",
      }),
    ).toEqual([]);
    expect(
      await rpc("claim_meta_review_targets", {
        p_worker_id: "uuid-replacement",
        p_reviewer_id: replacementId,
        p_reviewer_email: reviewEmail,
        p_generation: replacementGeneration,
        p_limit: 100,
        p_lease_seconds: 300,
      }),
    ).toEqual([]);
    const oldState = (await json(
      `/rest/v1/oauth_states?state_hash=eq.${stateHash}&select=completion_consumed_at,pending_authorization_code,pending_completion_handle_hash`,
    )) as Array<Record<string, unknown>>;
    expect(oldState).toEqual([
      expect.objectContaining({
        pending_authorization_code: null,
        pending_completion_handle_hash: null,
      }),
    ]);
    expect(oldState[0]!.completion_consumed_at).toEqual(expect.any(String));
    const oldTargets = (await json(
      `/rest/v1/post_targets?post_id=eq.${postId}&select=status,authorization_generation`,
    )) as Array<Record<string, unknown>>;
    expect(oldTargets).toEqual([
      {
        status: "blocked_authorization",
        authorization_generation: oldGeneration,
      },
    ]);
  });
});
