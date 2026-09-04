import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_ATTEMPT_TIMEOUT_MS,
  runAuditWithRetry,
} from "../../../scripts/audit-with-retry.mjs";

describe("dependency audit retry", () => {
  it("retries one failure and preserves a successful result", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });
    const report = vi.fn();

    expect(runAuditWithRetry({ spawn, platform: "linux", report })).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith(
      "corepack",
      ["pnpm", "audit", "--audit-level", "high"],
      expect.objectContaining({
        timeout: AUDIT_ATTEMPT_TIMEOUT_MS,
        killSignal: "SIGTERM",
      }),
    );
    expect(report).toHaveBeenCalledOnce();
  });

  it("reports timeouts and fails after exactly two attempts", () => {
    const timeout = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
    });
    const spawn = vi.fn(() => ({ status: null, error: timeout }));
    const report = vi.fn();

    expect(
      runAuditWithRetry({ spawn, platform: "linux", timeoutMs: 1_000, report }),
    ).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(report.mock.calls.flat().join(" ")).toContain(
      "attempt 2 timed out after 1 seconds",
    );
  });
});
