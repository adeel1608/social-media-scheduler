import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";

const incompleteProduction = {
  ENVIRONMENT: "production",
  LIVE_TEST_CONFIRM: "false",
  META_APP_REVIEW_APPROVED: "false",
  TIKTOK_CONTENT_POSTING_AUDITED: "false",
  YOUTUBE_API_AUDIT_APPROVED: "false",
} as Env;

describe("production HTTP fail-closed gate", () => {
  it("keeps health diagnostic but blocks every other incomplete route", async () => {
    const health = await app.request(
      "https://worker.example.test/health",
      undefined,
      incompleteProduction,
    );
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      status: "configuration_required",
      configured: false,
    });

    for (const path of [
      "/",
      "/api/setup",
      "/api/oauth/instagram/callback?code=code&state=state",
      "/api/uploadthing",
      "/delivery/not-a-key",
    ]) {
      const response = await app.request(
        `https://worker.example.test${path}`,
        undefined,
        incompleteProduction,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "configuration_required",
        message: "Production configuration is incomplete.",
      });
    }
  });
});
