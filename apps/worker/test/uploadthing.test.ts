import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  authorizeUploadInitiation,
  completeUploadThingCallback,
  handleUploadThingRequest,
  type UploadThingRouteDependencies,
} from "../src/uploadthing";

const mediaId = "123e4567-e89b-42d3-a456-426614174000";

function token() {
  return btoa(
    JSON.stringify({
      apiKey: `sk_live_${"x".repeat(48)}`,
      appId: "postline123",
      regions: ["syd1"],
    }),
  );
}

function env(): Env {
  return {
    ENVIRONMENT: "production",
    WORKER_PUBLIC_URL: "https://worker.example.test",
    UPLOADTHING_TOKEN: token(),
  } as Env;
}

function input() {
  return {
    filename: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_024,
    width: 1080,
    height: 1920,
    durationSeconds: 12,
  };
}

function dependencies(
  overrides: Partial<UploadThingRouteDependencies> = {},
): UploadThingRouteDependencies {
  return {
    authenticate: vi.fn().mockResolvedValue({
      authenticated: true,
      jwt: "owner-jwt",
      user: { id: "owner-id", email: "owner@example.com" },
    }),
    consumeRateLimit: vi.fn().mockResolvedValue(true),
    reserve: vi.fn().mockResolvedValue(mediaId),
    finalize: vi.fn().mockResolvedValue("completed"),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("UploadThing initiation", () => {
  it("requires owner authentication before reserving storage", async () => {
    const deps = dependencies({
      authenticate: vi.fn().mockResolvedValue({
        authenticated: false,
        error: "authentication_required",
        status: 401,
      }),
    });

    await expect(
      authorizeUploadInitiation(
        env(),
        new Request("https://worker.example.test/api/uploadthing"),
        [{ name: "clip.mp4", type: "video/mp4", size: 1_024 }],
        input(),
        deps,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it("reserves quota for the authenticated owner and assigns a stable custom ID", async () => {
    const deps = dependencies();
    const result = await authorizeUploadInitiation(
      env(),
      new Request("https://worker.example.test/api/uploadthing", {
        headers: { Authorization: "Bearer owner-jwt" },
      }),
      [{ name: "clip.mp4", type: "video/mp4", size: 1_024 }],
      input(),
      deps,
    );

    expect(result.ownerId).toBe("owner-id");
    expect(result.mediaId).toBe(mediaId);
    expect(deps.reserve).toHaveBeenCalledOnce();
  });

  it("rejects a single file larger than the 1.8 GiB application cap", async () => {
    const deps = dependencies();
    const tooLarge = Math.floor(1.8 * 1024 ** 3) + 1;
    await expect(
      authorizeUploadInitiation(
        env(),
        new Request("https://worker.example.test/api/uploadthing"),
        [{ name: "clip.mp4", type: "video/mp4", size: tooLarge }],
        { ...input(), sizeBytes: tooLarge },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
});

describe("UploadThing callbacks", () => {
  const file = {
    key: "provider-key",
    customId: mediaId,
    name: "clip.mp4",
    size: 1_024,
    type: "video/mp4",
    ufsUrl: "https://postline123.ufs.sh/f/provider-key",
    fileHash: "abc123",
  };

  it("makes repeated completion callbacks idempotent", async () => {
    const finalize = vi
      .fn()
      .mockResolvedValueOnce("completed")
      .mockResolvedValueOnce("already_complete");
    const deps = dependencies({ finalize });

    const first = await completeUploadThingCallback(
      env(),
      { ownerId: "owner-id", mediaId },
      file,
      deps,
    );
    const second = await completeUploadThingCallback(
      env(),
      { ownerId: "owner-id", mediaId },
      file,
      deps,
    );

    expect(first.uploadStatus).toBe("complete");
    expect(second).toEqual(first);
    expect(deps.deleteFile).not.toHaveBeenCalled();
  });

  it("deletes a late file when its reservation expired", async () => {
    const deps = dependencies({
      finalize: vi.fn().mockResolvedValue("expired"),
    });

    await expect(
      completeUploadThingCallback(
        env(),
        { ownerId: "owner-id", mediaId },
        file,
        deps,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    expect(deps.deleteFile).toHaveBeenCalledWith(env(), "provider-key");
  });

  it("rejects an unsigned callback before application completion runs", async () => {
    const response = await handleUploadThingRequest(
      env(),
      new Request("https://worker.example.test/api/uploadthing?slug=media", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "uploadthing-hook": "callback",
          "x-uploadthing-version": "7.7.4",
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      message: "Invalid signature",
    });
  });
});
