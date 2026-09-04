import { describe, expect, it } from "vitest";

import { validateDeployConfiguration } from "../../../scripts/deploy-config.mjs";

const validEnvironment = {
  DEPLOY_CONFIRM: "DEPLOY",
  CLOUDFLARE_PAGES_PROJECT: "postline-owner",
  CLOUDFLARE_WORKER_NAME: "postline-owner-api",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "cloudflare-token-sentinel-1234567890",
  VITE_APP_URL: "https://postline-owner.pages.dev",
  VITE_API_URL: "https://postline-owner.workers.dev",
  VITE_SUPABASE_URL: "https://owner-project.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_owner_public_key_sentinel",
  VITE_DEMO_MODE: "false",
  VITE_OPERATOR_NAME: "Owner Postline",
  VITE_PUBLIC_CONTACT_EMAIL: "owner@postline.dev",
  GITHUB_REF_NAME: "main",
  GITHUB_DEFAULT_BRANCH: "main",
};

describe("production deployment preflight", () => {
  it("accepts complete browser-safe and Cloudflare configuration", () => {
    expect(validateDeployConfiguration(validEnvironment)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("fails closed on missing values without returning their contents", () => {
    const result = validateDeployConfiguration({
      ...validEnvironment,
      CLOUDFLARE_API_TOKEN: "",
      VITE_SUPABASE_ANON_KEY: "",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "CLOUDFLARE_API_TOKEN is missing",
        "VITE_SUPABASE_ANON_KEY is missing",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("cloudflare-token-sentinel");
  });

  it("rejects placeholders, unsafe origins, and absent confirmation", () => {
    const result = validateDeployConfiguration({
      ...validEnvironment,
      DEPLOY_CONFIRM: "",
      CLOUDFLARE_PAGES_PROJECT: "your-project",
      VITE_API_URL: "https://postline-owner.workers.dev/path",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "DEPLOY_CONFIRM must exactly equal DEPLOY",
        "CLOUDFLARE_PAGES_PROJECT contains a placeholder",
        "VITE_API_URL must be a credential-free HTTPS origin",
      ]),
    );
  });

  it("rejects deployment from a non-default branch", () => {
    const result = validateDeployConfiguration({
      ...validEnvironment,
      GITHUB_REF_NAME: "feature/unreviewed",
    });

    expect(result.errors).toContain(
      "the deployment ref must be the repository default branch",
    );
  });
});
