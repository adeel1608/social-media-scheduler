import { describe, expect, it } from "vitest";

import {
  isBoundedEmail,
  resolvePublicIdentity,
  resolvePublicWebConfiguration,
} from "../src/lib/publicIdentity";

describe("public legal identity", () => {
  it("rejects missing and placeholder production contact values", () => {
    expect(() =>
      resolvePublicIdentity({
        VITE_DEMO_MODE: "false",
        VITE_OPERATOR_NAME: "Postline",
      }),
    ).toThrow(/VITE_PUBLIC_CONTACT_EMAIL is required/);

    for (const contactEmail of [
      "owner@example.com",
      "replace-me@postline.dev",
      "demo@postline.dev",
      "owner@postline.test",
    ]) {
      expect(() =>
        resolvePublicIdentity({
          VITE_DEMO_MODE: "false",
          VITE_OPERATOR_NAME: "Postline",
          VITE_PUBLIC_CONTACT_EMAIL: contactEmail,
        }),
      ).toThrow(/valid, non-placeholder public email/);
    }
  });

  it("keeps the explicitly labelled local demo usable", () => {
    expect(resolvePublicIdentity({ VITE_DEMO_MODE: "true" })).toEqual({
      operatorName: "Postline Demo",
      contactEmail: "demo@example.com",
    });
  });

  it("returns configured production identity values", () => {
    expect(
      resolvePublicIdentity({
        VITE_DEMO_MODE: "false",
        VITE_OPERATOR_NAME: "Independent Postline",
        VITE_PUBLIC_CONTACT_EMAIL: "legal@independent-postline.dev",
      }),
    ).toEqual({
      operatorName: "Independent Postline",
      contactEmail: "legal@independent-postline.dev",
    });
  });

  it("bounds email syntax checks without a complex expression", () => {
    expect(isBoundedEmail("legal@independent-postline.dev")).toBe(true);
    expect(isBoundedEmail(`owner@${"a".repeat(64)}.dev`)).toBe(false);
    expect(isBoundedEmail("two@@postline.dev")).toBe(false);
    expect(isBoundedEmail("owner@postline")).toBe(false);
  });
});

describe("public production configuration", () => {
  const validEnvironment = {
    VITE_DEMO_MODE: "false",
    VITE_APP_URL: "https://postline.pages.dev",
    VITE_API_URL: "https://postline-api.workers.dev",
    VITE_SUPABASE_URL: "https://project.supabase.co",
    VITE_SUPABASE_ANON_KEY: "sb_publishable_abcdefghijklmnopqrstuvwxyz",
    VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    VITE_OPERATOR_NAME: "Independent Postline",
    VITE_PUBLIC_CONTACT_EMAIL: "legal@independent-postline.dev",
  };

  it("requires every browser-safe production value", () => {
    for (const key of [
      "VITE_APP_URL",
      "VITE_API_URL",
      "VITE_SUPABASE_URL",
      "VITE_SUPABASE_ANON_KEY",
      "VITE_TURNSTILE_SITE_KEY",
    ] as const) {
      expect(() =>
        resolvePublicWebConfiguration({
          ...validEnvironment,
          [key]: "",
        }),
      ).toThrow(new RegExp(`${key} is required`));
    }
  });

  it("rejects placeholders and URL values that are not HTTPS origins", () => {
    expect(() =>
      resolvePublicWebConfiguration({
        ...validEnvironment,
        VITE_SUPABASE_URL: "https://your-project.supabase.co",
      }),
    ).toThrow(/must not contain a placeholder/);
    expect(() =>
      resolvePublicWebConfiguration({
        ...validEnvironment,
        VITE_API_URL: "https://postline-api.workers.dev/path",
      }),
    ).toThrow(/credential-free HTTPS origin/);
  });

  it("returns normalized production values without server configuration", () => {
    expect(resolvePublicWebConfiguration(validEnvironment)).toEqual({
      appUrl: "https://postline.pages.dev",
      apiUrl: "https://postline-api.workers.dev",
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "sb_publishable_abcdefghijklmnopqrstuvwxyz",
      turnstileSiteKey: "1x00000000000000000000AA",
      identity: {
        operatorName: "Independent Postline",
        contactEmail: "legal@independent-postline.dev",
      },
    });
  });

  it("rejects a malformed production Turnstile site key", () => {
    expect(() =>
      resolvePublicWebConfiguration({
        ...validEnvironment,
        VITE_TURNSTILE_SITE_KEY: "not a site key",
      }),
    ).toThrow(/valid public site key/);
  });
});
