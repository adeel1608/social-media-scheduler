import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  deleteUploadThingFile,
  deliveryResponse,
  fetchMediaRange,
  MediaStorageError,
  parseSingleRange,
  reservationDeletionTarget,
  signedDeliveryUrl,
  type StoredMedia,
  validateUploadThingUrl,
  verifyDeliveryRequest,
} from "../src/storage";

const mediaId = "123e4567-e89b-42d3-a456-426614174000";
const ownerId = "223e4567-e89b-42d3-a456-426614174000";
const fileKey = "opaque-provider-key";

function token() {
  return btoa(
    JSON.stringify({
      apiKey: `sk_live_${"x".repeat(48)}`,
      appId: "postline123",
      regions: ["syd1"],
    }),
  );
}

function storageEnv(): Env {
  return {
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(7)),
    ),
    UPLOADTHING_TOKEN: token(),
    WORKER_PUBLIC_URL: "https://media.example.test",
  } as Env;
}

function media(): StoredMedia {
  return {
    id: mediaId,
    owner_id: "owner-id",
    storage_provider: "uploadthing",
    provider_file_key: fileKey,
    provider_url: `https://postline123.ufs.sh/f/${fileKey}`,
    object_key: fileKey,
    mime_type: "video/mp4",
    size_bytes: 1_000,
    upload_status: "complete",
    deleted_at: null,
  };
}

describe("UploadThing URL safety", () => {
  it("allows only the configured app CDN and documented legacy host", () => {
    const env = storageEnv();
    expect(
      validateUploadThingUrl(env, `https://postline123.ufs.sh/f/${fileKey}`, [
        fileKey,
      ]).hostname,
    ).toBe("postline123.ufs.sh");
    expect(
      validateUploadThingUrl(env, `https://utfs.io/f/${fileKey}`, [fileKey])
        .hostname,
    ).toBe("utfs.io");
  });

  it.each([
    "http://postline123.ufs.sh/f/opaque-provider-key",
    "https://evil.example/f/opaque-provider-key",
    "https://localhost/f/opaque-provider-key",
    "https://127.0.0.1/f/opaque-provider-key",
    "https://postline123.ufs.sh:444/f/opaque-provider-key",
    "https://user:pass@postline123.ufs.sh/f/opaque-provider-key",
    "https://postline123.ufs.sh/f/another-key",
    "https://postline123.ufs.sh/f/opaque-provider-key?redirect=1",
    "https://postline123.ufs.sh/f/opaque-provider-key/extra",
  ])("rejects an unsafe provider URL: %s", (value) => {
    expect(() =>
      validateUploadThingUrl(storageEnv(), value, [fileKey]),
    ).toThrow(MediaStorageError);
  });
});

describe("signed provider delivery", () => {
  it("signs an opaque media ID and rejects tampering or expiry", async () => {
    const env = storageEnv();
    const signed = new URL(
      await signedDeliveryUrl(env, { mediaId, ownerId }, 300),
    );
    const encoded = signed.pathname.split("/").pop()!;

    expect(signed.origin).toBe("https://media.example.test");
    expect(signed.pathname).not.toContain(mediaId);
    expect(
      await verifyDeliveryRequest(
        env,
        encoded,
        signed.searchParams.get("expires") ?? undefined,
        signed.searchParams.get("signature") ?? undefined,
      ),
    ).toEqual({ mediaId, ownerId });
    expect(
      await verifyDeliveryRequest(
        env,
        encoded,
        signed.searchParams.get("expires") ?? undefined,
        `${signed.searchParams.get("signature")}x`,
      ),
    ).toBeNull();
    expect(
      await verifyDeliveryRequest(env, encoded, "1000000000", "invalid"),
    ).toBeNull();
  });

  it("supports HEAD without exposing upstream headers", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("HEAD");
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": "1000",
            "Set-Cookie": "must-not-leak=true",
            Server: "must-not-leak",
          },
        });
      },
    ) as typeof fetch;
    const response = await deliveryResponse(
      storageEnv(),
      media(),
      "HEAD",
      undefined,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("1000");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Server")).toBeNull();
  });

  it("streams a valid single range and validates the upstream range", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Range")).toBe("bytes=100-199");
        expect(init?.redirect).toBe("manual");
        return new Response(new Uint8Array(100), {
          status: 206,
          headers: {
            "Content-Length": "100",
            "Content-Range": "bytes 100-199/1000",
          },
        });
      },
    ) as typeof fetch;
    const response = await deliveryResponse(
      storageEnv(),
      media(),
      "GET",
      "bytes=100-199",
      fetcher,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 100-199/1000");
    expect(response.body).not.toBeNull();
  });

  it("rejects malformed and multi-range requests without fetching", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    for (const value of ["items=0-1", "bytes=", "bytes=1-2,4-5"]) {
      const response = await deliveryResponse(
        storageEnv(),
        media(),
        "GET",
        value,
        fetcher,
      );
      expect(response.status).toBe(416);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports suffix ranges and rejects out-of-bounds starts", () => {
    expect(parseSingleRange("bytes=-100", 1_000)).toEqual({
      start: 900,
      end: 999,
      length: 100,
    });
    expect(parseSingleRange("bytes=1000-", 1_000)).toBeNull();
  });

  it("rejects upstream redirects instead of following them", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/private" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      deliveryResponse(storageEnv(), media(), "GET", undefined, fetcher),
    ).rejects.toMatchObject({ code: "provider_redirect_rejected" });
  });
});

describe("worker media reads and deletion", () => {
  it("reconciles expired reservations by stable custom ID before the provider key is known", () => {
    expect(
      reservationDeletionTarget({ id: mediaId, provider_file_key: null }),
    ).toEqual({ identifier: mediaId, keyType: "customId" });
    expect(
      reservationDeletionTarget({ id: mediaId, provider_file_key: fileKey }),
    ).toEqual({ identifier: fileKey, keyType: "fileKey" });
  });

  it("uses and validates a fixed UploadThing range for provider chunks", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array(256), {
          status: 206,
          headers: {
            "Content-Length": "256",
            "Content-Range": "bytes 0-255/1000",
          },
        }),
    ) as unknown as typeof fetch;
    const body = await fetchMediaRange(storageEnv(), media(), 0, 256, fetcher);

    expect(body).toBeInstanceOf(ReadableStream);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("confirms deletion and treats a zero deletion count as already absent", async () => {
    const deleted = await deleteUploadThingFile(
      storageEnv(),
      fileKey,
      "fileKey",
      {
        deleteFiles: vi
          .fn()
          .mockResolvedValue({ success: true, deletedCount: 1 }),
      },
    );
    const absent = await deleteUploadThingFile(
      storageEnv(),
      mediaId,
      "customId",
      {
        deleteFiles: vi
          .fn()
          .mockResolvedValue({ success: true, deletedCount: 0 }),
      },
    );

    expect(deleted).toEqual({ confirmed: true, alreadyAbsent: false });
    expect(absent).toEqual({ confirmed: true, alreadyAbsent: true });
  });

  it("does not confirm an unsuccessful provider deletion", async () => {
    await expect(
      deleteUploadThingFile(storageEnv(), fileKey, "fileKey", {
        deleteFiles: vi
          .fn()
          .mockResolvedValue({ success: false, deletedCount: 0 }),
      }),
    ).rejects.toMatchObject({ code: "provider_delete_failed" });
  });
});
