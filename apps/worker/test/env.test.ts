import { describe, expect, it } from "vitest";

import {
  assertProductionConfigured,
  configurationStatus,
  type Env,
} from "../src/env";

describe("fail-closed production configuration", () => {
  it("reports missing configuration and throws only in production", () => {
    const env = {
      ENVIRONMENT: "production",
      META_APP_REVIEW_APPROVED: "false",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      YOUTUBE_API_AUDIT_APPROVED: "false",
      LIVE_TEST_CONFIRM: "false",
    } as Env;
    expect(configurationStatus(env).configured).toBe(false);
    expect(() => assertProductionConfigured(env)).toThrow(
      "Production configuration incomplete",
    );
    expect(() =>
      assertProductionConfigured({ ...env, ENVIRONMENT: "development" }),
    ).not.toThrow();
  });

  it("rejects malformed encryption keys and non-HTTPS production origins", () => {
    const env = {
      ENVIRONMENT: "development",
      TOKEN_ENCRYPTION_KEY: "not-base64",
      APP_URL: "http://public.example.com",
      R2_PUBLIC_DELIVERY_HOST: "https://media.example.com/path",
      META_APP_REVIEW_APPROVED: "false",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      YOUTUBE_API_AUDIT_APPROVED: "false",
      LIVE_TEST_CONFIRM: "false",
    } as Env;
    expect(configurationStatus(env).invalid).toEqual(
      expect.arrayContaining([
        "TOKEN_ENCRYPTION_KEY",
        "APP_URL",
        "R2_PUBLIC_DELIVERY_HOST",
      ]),
    );
  });
});
