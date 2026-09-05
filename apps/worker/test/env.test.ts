import { describe, expect, it } from "vitest";

import {
  assertProductionConfigured,
  configurationStatus,
  ownerSetupStatus,
  type Env,
} from "../src/env";

describe("fail-closed production configuration", () => {
  it("accepts a complete production-shaped configuration", () => {
    const uploadThingToken = btoa(
      JSON.stringify({
        apiKey: `sk_live_${"x".repeat(48)}`,
        appId: "postline123",
        regions: ["syd1"],
      }),
    );
    const env = {
      PUBLISH_QUEUE: {},
      ENVIRONMENT: "production",
      APP_URL: "https://postline.dev",
      WORKER_PUBLIC_URL: "https://api.postline.dev",
      OWNER_EMAIL: "owner@postline.dev",
      NOTIFICATION_EMAIL: "owner@postline.dev",
      TIMEZONE: "Australia/Melbourne",
      LIVE_TEST_CONFIRM: "false",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "sb_publishable_public-key-sentinel",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-sentinel",
      TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
      TOKEN_ENCRYPTION_KEY_VERSION: "v1",
      UPLOADTHING_TOKEN: uploadThingToken,
      RESEND_API_KEY: "resend-key-sentinel",
      RESEND_FROM: "Postline <onboarding@resend.dev>",
      META_APP_ID: "meta-app-id",
      META_APP_SECRET: "meta-secret",
      META_REDIRECT_URI:
        "https://api.postline.dev/api/oauth/instagram/callback",
      META_GRAPH_VERSION: "v23.0",
      META_APP_REVIEW_APPROVED: "false",
      TIKTOK_CLIENT_KEY: "tiktok-client-key",
      TIKTOK_CLIENT_SECRET: "tiktok-secret",
      TIKTOK_REDIRECT_URI: "https://api.postline.dev/api/oauth/tiktok/callback",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      GOOGLE_CLIENT_ID: "google-client-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI:
        "https://api.postline.dev/api/oauth/youtube/callback",
      YOUTUBE_API_AUDIT_APPROVED: "false",
    } as Env;

    expect(configurationStatus(env)).toMatchObject({
      configured: true,
      missing: [],
      invalid: [],
      liveTestSafetyEnabled: false,
    });
    expect(() => assertProductionConfigured(env)).not.toThrow();
  });

  it("reports missing configuration and permits only an explicit development bypass", () => {
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
    expect(() =>
      assertProductionConfigured({ ...env, ENVIRONMENT: "staging" }),
    ).toThrow("Production configuration incomplete");
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

  it("rejects local HTTP origins outside explicit development", () => {
    const status = configurationStatus({
      ENVIRONMENT: "production",
      APP_URL: "http://localhost",
      WORKER_PUBLIC_URL: "http://127.0.0.1",
    } as Env);

    expect(status.invalid).toEqual(
      expect.arrayContaining(["APP_URL", "WORKER_PUBLIC_URL"]),
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

  it("requires exact origins and Worker-owned OAuth callbacks", () => {
    const status = configurationStatus({
      ENVIRONMENT: "production",
      APP_URL: "https://postline.example.dev/",
      WORKER_PUBLIC_URL: "https://api.postline.example.dev",
      SUPABASE_URL: "https://project.supabase.co/path",
      META_REDIRECT_URI: "https://other.example.dev/callback",
      TIKTOK_REDIRECT_URI:
        "https://api.postline.example.dev/api/oauth/tiktok/callback",
      GOOGLE_REDIRECT_URI:
        "https://api.postline.example.dev/api/oauth/youtube/callback",
    } as Env);

    expect(status.invalid).toEqual(
      expect.arrayContaining(["APP_URL", "SUPABASE_URL", "META_REDIRECT_URI"]),
    );
    expect(status.invalid).not.toContain("TIKTOK_REDIRECT_URI");
    expect(status.invalid).not.toContain("GOOGLE_REDIRECT_URI");
  });

  it("requires encryption-key versioning and exact boolean flags", () => {
    const status = configurationStatus({
      ENVIRONMENT: "production",
      LIVE_TEST_CONFIRM: "yes",
      META_APP_REVIEW_APPROVED: "no",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      YOUTUBE_API_AUDIT_APPROVED: "false",
    } as Env);

    expect(status.missing).toContain("TOKEN_ENCRYPTION_KEY_VERSION");
    expect(status.invalid).toEqual(
      expect.arrayContaining(["LIVE_TEST_CONFIRM", "META_APP_REVIEW_APPROVED"]),
    );
  });

  it("requires a canonical encryption-key version for unambiguous bindings", () => {
    for (const version of ["V1", "v1-old", "v1_old", "1", "v".repeat(33)]) {
      const status = configurationStatus({
        TOKEN_ENCRYPTION_KEY_VERSION: version,
      } as Env);
      expect(status.invalid).toContain("TOKEN_ENCRYPTION_KEY_VERSION");
    }
    expect(
      configurationStatus({ TOKEN_ENCRYPTION_KEY_VERSION: "v12" } as Env)
        .invalid,
    ).not.toContain("TOKEN_ENCRYPTION_KEY_VERSION");
  });

  it("rejects production placeholders and a mixed-case owner identity", () => {
    const status = configurationStatus({
      ENVIRONMENT: "production",
      OWNER_EMAIL: "Owner@example.com",
      SUPABASE_URL: "https://your-project.supabase.co",
    } as Env);

    expect(status.invalid).toEqual(
      expect.arrayContaining(["OWNER_EMAIL", "SUPABASE_URL"]),
    );
  });

  it("allows the Resend test sender only for owner-address notifications", () => {
    const valid = configurationStatus({
      OWNER_EMAIL: "owner@postline.dev",
      NOTIFICATION_EMAIL: "owner@postline.dev",
      RESEND_FROM: "Postline <onboarding@resend.dev>",
    } as Env);
    expect(valid.invalid).not.toEqual(
      expect.arrayContaining(["RESEND_FROM", "NOTIFICATION_EMAIL"]),
    );

    const invalid = configurationStatus({
      OWNER_EMAIL: "owner@postline.dev",
      NOTIFICATION_EMAIL: "someone-else@postline.dev",
      RESEND_FROM: "anything@resend.dev",
    } as Env);
    expect(invalid.invalid).toEqual(
      expect.arrayContaining(["RESEND_FROM", "NOTIFICATION_EMAIL"]),
    );
  });

  it("returns only browser-safe service readiness from the owner setup endpoint", () => {
    const status = ownerSetupStatus({
      ENVIRONMENT: "production",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "sb_publishable_public-key-sentinel",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-sentinel",
      WORKER_PUBLIC_URL: "https://api.postline.dev",
      UPLOADTHING_TOKEN: "invalid-token",
      RESEND_API_KEY: "resend-key-sentinel",
      RESEND_FROM: "Postline <owner@postline.dev>",
      OWNER_EMAIL: "owner@postline.dev",
      NOTIFICATION_EMAIL: "owner@postline.dev",
      META_APP_REVIEW_APPROVED: "false",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      YOUTUBE_API_AUDIT_APPROVED: "false",
      LIVE_TEST_CONFIRM: "false",
    } as Env);

    expect(status.services).toEqual({
      databaseAuth: true,
      mediaStorage: false,
      notifications: true,
    });
    const response = JSON.stringify(status);
    for (const serverOnlyName of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "UPLOADTHING_TOKEN",
      "RESEND_API_KEY",
    ]) {
      expect(response).not.toContain(serverOnlyName);
    }
  });
});
