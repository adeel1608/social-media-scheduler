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
      WORKER_PUBLIC_URL: "https://worker.example.com/path",
      UPLOADTHING_TOKEN: "not-a-token",
      META_APP_REVIEW_APPROVED: "false",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      YOUTUBE_API_AUDIT_APPROVED: "false",
      LIVE_TEST_CONFIRM: "false",
    } as Env;
    expect(configurationStatus(env).invalid).toEqual(
      expect.arrayContaining([
        "TOKEN_ENCRYPTION_KEY",
        "APP_URL",
        "WORKER_PUBLIC_URL",
        "UPLOADTHING_TOKEN",
      ]),
    );
  });

  it("validates email settings with bounded string checks", () => {
    const valid = configurationStatus({
      OWNER_EMAIL: "owner@example.com",
      NOTIFICATION_EMAIL: "alerts@example.com",
    } as Env);

    expect(valid.invalid).not.toContain("OWNER_EMAIL");
    expect(valid.invalid).not.toContain("NOTIFICATION_EMAIL");

    const invalid = configurationStatus({
      OWNER_EMAIL: "owner @example.com",
      NOTIFICATION_EMAIL: "alerts@example",
    } as Env);

    expect(invalid.invalid).toEqual(
      expect.arrayContaining(["OWNER_EMAIL", "NOTIFICATION_EMAIL"]),
    );
  });

  it("requires the Worker callback URL to be a credential-free origin", () => {
    const status = configurationStatus({
      WORKER_PUBLIC_URL: "https://user:password@worker.example.test/",
    } as Env);

    expect(status.invalid).toContain("WORKER_PUBLIC_URL");
  });
});
