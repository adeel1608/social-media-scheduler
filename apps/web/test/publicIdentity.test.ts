import { describe, expect, it } from "vitest";

import {
  isBoundedEmail,
  resolvePublicIdentity,
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
