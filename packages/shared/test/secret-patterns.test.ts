import { describe, expect, it } from "vitest";

import { containsPotentialSecret } from "../../../scripts/secret-patterns.mjs";

describe("source secret patterns", () => {
  it.each([
    `sb_${"secret_"}${"a".repeat(24)}`,
    `GOCSPX-${"b".repeat(24)}`,
    `SUPABASE_SERVICE_ROLE_KEY: eyJ${"c".repeat(36)}`,
    `META_APP_SECRET=${"d".repeat(32)}`,
    `CLOUDFLARE_API_TOKEN=${"e".repeat(40)}`,
    `TOKEN_ENCRYPTION_KEY=${"f".repeat(43)}=`,
    `UPLOADTHING_TOKEN=${"g".repeat(48)}`,
  ])("detects a representative server credential", (candidate) => {
    expect(containsPotentialSecret(candidate)).toBe(true);
  });

  it.each([
    "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "GOOGLE_CLIENT_SECRET=replace-with-client-secret",
    "UPLOADTHING_TOKEN: process.env.UPLOADTHING_TOKEN",
    'TOKEN_ENCRYPTION_KEY: "POSTLINE_TEST_SENTINEL_NOT_A_SECRET"',
  ])("allows references, placeholders, and test sentinels", (candidate) => {
    expect(containsPotentialSecret(candidate)).toBe(false);
  });
});
