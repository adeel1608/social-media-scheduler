import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";

const ownerId = "11111111-1111-4111-8111-111111111111";
const mediaId = "22222222-2222-4222-8222-222222222222";
const providerKey = "provider-file-key";

function uploadThingToken(): string {
  return btoa(
    JSON.stringify({
      apiKey: `sk_live_${"x".repeat(48)}`,
      appId: "postline123",
      regions: ["syd1"],
    }),
  );
}

const environment = {
  ENVIRONMENT: "development",
  OWNER_EMAIL: "owner@postline.dev",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "public-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  UPLOADTHING_TOKEN: uploadThingToken(),
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockDeletion(providerOk: boolean) {
  const mediaWrites: Array<{
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const providerCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user"))
        return Response.json({ id: ownerId, email: "owner@postline.dev" });
      if (url.includes("/rest/v1/media_assets?") && init.method !== "PATCH")
        return Response.json([
          {
            id: mediaId,
            storage_provider: "uploadthing",
            provider_file_key: providerKey,
          },
        ]);
      if (url.includes("/rest/v1/post_media?"))
        return Response.json([
          { posts: { post_targets: [{ status: "published" }] } },
        ]);
      if (url.includes("/rest/v1/media_assets?") && init.method === "PATCH") {
        mediaWrites.push({
          authorization: new Headers(init.headers).get("Authorization"),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return Response.json([{}]);
      }
      providerCalls.push(url);
      return providerOk
        ? Response.json({ success: true, deletedCount: 1 })
        : Response.json({ error: "synthetic_failure" }, { status: 502 });
    }),
  );
  return { mediaWrites, providerCalls };
}

function request() {
  return app.request(
    `https://worker.example.test/api/media/${mediaId}`,
    {
      method: "DELETE",
      headers: { Authorization: "Bearer owner-jwt" },
    },
    environment,
  );
}

describe("trusted media cleanup mutation boundary", () => {
  it("uses service-role writes only after authenticated owner reads and provider confirmation", async () => {
    const { mediaWrites, providerCalls } = mockDeletion(true);
    const response = await request();
    expect(response.status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(mediaWrites).toHaveLength(2);
    expect(
      mediaWrites.every(
        (write) => write.authorization === "Bearer service-key",
      ),
    ).toBe(true);
    expect(mediaWrites[0]!.body).toMatchObject({ deletion_status: "pending" });
    expect(mediaWrites[1]!.body).toMatchObject({
      deletion_status: "confirmed",
      upload_status: "deleted",
    });
    expect(mediaWrites[1]!.body.deleted_at).toEqual(expect.any(String));
  });

  it("does not release quota when provider deletion is not confirmed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mediaWrites, providerCalls } = mockDeletion(false);
    const response = await request();
    expect(response.status).toBe(502);
    expect(providerCalls).toHaveLength(1);
    expect(mediaWrites).toHaveLength(2);
    expect(mediaWrites[0]!.body).toMatchObject({ deletion_status: "pending" });
    expect(mediaWrites[1]!.body).toEqual({
      deletion_status: "failed",
      deletion_last_error: "provider_delete_not_confirmed",
    });
    expect(mediaWrites.some((write) => "deleted_at" in write.body)).toBe(false);
    expect(
      mediaWrites.some((write) => "provider_deleted_at" in write.body),
    ).toBe(false);
    expect(
      mediaWrites.some((write) => write.body.upload_status === "deleted"),
    ).toBe(false);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      '{"level":"error","message":"uploadthing_delete_failed","state":"delete_file","classification":"provider_failure"}',
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(providerKey);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "synthetic_failure",
    );
  });
});
