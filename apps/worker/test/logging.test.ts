import { describe, expect, it, vi } from "vitest";

import { formatWorkerError, logWorkerError } from "../src/logging";

describe("sanitized Worker error logging", () => {
  it("retains stable codes and safe identifiers", () => {
    expect(
      JSON.parse(
        formatWorkerError("queue_job_failed", {
          requestId: "abc123-SYD",
          targetId: "a1b2c3d4-1111-2222-3333-abcdefabcdef",
        }),
      ),
    ).toEqual({
      level: "error",
      message: "queue_job_failed",
      requestId: "abc123-SYD",
      targetId: "a1b2c3d4-1111-2222-3333-abcdefabcdef",
    });
  });

  it("drops untrusted context instead of logging it", () => {
    const output = formatWorkerError("request_failed", {
      requestId: "Bearer secret-value",
      targetId: "https://signed.example/path?token=secret",
    });

    expect(JSON.parse(output)).toEqual({
      level: "error",
      message: "request_failed",
    });
    expect(output).not.toContain("secret-value");
  });

  it("logs only allow-listed configuration key names", () => {
    const output = formatWorkerError("configuration_incomplete", {
      missingKeys: ["SUPABASE_URL", "OWNER_EMAIL"],
      invalidKeys: ["TOKEN_ENCRYPTION_KEY", "not-a-binding-value" as "APP_URL"],
    });

    expect(JSON.parse(output)).toEqual({
      level: "error",
      message: "configuration_incomplete",
      missingKeys: ["SUPABASE_URL", "OWNER_EMAIL"],
      invalidKeys: ["TOKEN_ENCRYPTION_KEY"],
    });
    expect(output).not.toContain("not-a-binding-value");
  });

  it.each([
    "https://worker.example.test/api/oauth/instagram/callback?code=SYNTHETIC&state=SYNTHETIC",
    "https://worker.example.test/delivery/media?signature=SYNTHETIC&expires=1234567890",
    "Cookie: oauth-binding=SYNTHETIC",
    "Bearer SYNTHETIC",
  ])("drops sensitive request context: %s", (value) => {
    const output = formatWorkerError("request_failed", {
      requestId: value,
      targetId: value,
      messageId: value,
      provider: value,
      state: value,
      classification: value,
    });
    expect(JSON.parse(output)).toEqual({
      level: "error",
      message: "request_failed",
    });
    expect(output).not.toContain("SYNTHETIC");
  });

  it("writes only the formatted safe entry", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    logWorkerError("media_retention_update_failed", { targetId: "target-1" });
    expect(error).toHaveBeenCalledWith(
      '{"level":"error","message":"media_retention_update_failed","targetId":"target-1"}',
    );
    error.mockRestore();
  });
});
