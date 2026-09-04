import { describe, expect, it } from "vitest";

import { genericNormalizeError, trustedUploadSessionUrl } from "../src/http";

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
});
