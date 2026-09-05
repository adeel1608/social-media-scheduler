import { describe, expect, it, vi } from "vitest";

import {
  genericNormalizeError,
  jsonRequest,
  trustedUploadSessionUrl,
} from "../src/http";

describe("platform error sanitization", () => {
  it("redacts credentials and URLs before errors are persisted or emailed", () => {
    const normalized = genericNormalizeError({
      status: 400,
      body: {
        error: {
          code: "provider_error",
          message:
            "Bearer secret-token failed at https://upload.example/path?token=secret",
        },
      },
    });

    expect(normalized).toMatchObject({
      code: "provider_error",
      message: "Bearer [REDACTED] failed at [REDACTED_URL]",
      ambiguous: false,
    });
  });

  it("bounds untrusted provider codes and messages", () => {
    const normalized = genericNormalizeError({
      body: {
        code: "unsafe code with spaces",
        message: "x".repeat(600),
      },
    });

    expect(normalized.code).toBe("platform_error");
    expect(normalized.message).toHaveLength(500);
  });

  it("allows only documented provider upload session URLs", () => {
    expect(
      trustedUploadSessionUrl(
        "youtube",
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1",
      ),
    ).toContain("upload_id=session-1");
    expect(
      trustedUploadSessionUrl(
        "tiktok",
        "https://open-upload.tiktokapis.com/video/?upload_id=session-1&upload_token=opaque",
      ),
    ).toContain("upload_token=opaque");

    for (const [platform, url] of [
      [
        "youtube",
        "https://www.googleapis.com.evil.example/upload/youtube/v3/videos?uploadType=resumable&upload_id=x",
      ],
      [
        "youtube",
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable",
      ],
      ["tiktok", "https://open-upload.tiktokapis.com.evil.example/video/"],
      ["tiktok", "https://open-upload.tiktokapis.com/other/"],
    ] as const) {
      expect(() => trustedUploadSessionUrl(platform, url)).toThrow();
    }
  });

  it("bounds outbound provider requests and returns a sanitized timeout error", async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("test URL and secret", "AbortError")),
            { once: true },
          );
        }),
    );

    await expect(
      jsonRequest(
        fetcher,
        "https://provider.example/token?code=sensitive",
        { operation: "read" },
        5,
      ),
    ).rejects.toEqual({
      name: "NetworkError",
      code: "network_error",
      message: "Network request failed",
      retryable: true,
      ambiguous: false,
    });
  });

  it.each([
    ["read", true, false],
    ["idempotent", true, false],
    ["publish", false, true],
  ] as const)(
    "classifies network failures by %s operation semantics",
    async (operation, retryable, ambiguous) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("timeout"));

      await expect(
        jsonRequest(fetcher, "https://provider.example/request", {
          operation,
          method: "POST",
        }),
      ).rejects.toMatchObject({ retryable, ambiguous });
    },
  );

  it.each([
    ["read", 429, true, false],
    ["read", 503, true, false],
    ["publish", 429, true, false],
    ["publish", 503, false, true],
  ] as const)(
    "classifies %s HTTP %i responses without method inference",
    async (operation, status, retryable, ambiguous) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status }));

      await expect(
        jsonRequest(fetcher, "https://provider.example/request", {
          operation,
          method: operation === "read" ? "POST" : "PUT",
        }),
      ).rejects.toMatchObject({ status, retryable, ambiguous });
    },
  );
});
