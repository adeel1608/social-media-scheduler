import { describe, expect, it } from "vitest";

import { genericNormalizeError } from "../src/http";

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
});
