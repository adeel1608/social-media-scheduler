import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/deploy.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);
const wrangler = readFileSync(
  resolve(process.cwd(), "apps/worker/wrangler.toml"),
  "utf8",
);

describe("production deployment safety", () => {
  it("cancels obsolete CI runs without affecting production deployment", () => {
    expect(ciWorkflow).toContain(
      "group: ci-${{ github.workflow }}-${{ github.ref }}",
    );
    expect(ciWorkflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("retains manual and protected-environment release gates", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("DEPLOY_CONFIRM: ${{ inputs.confirm }}");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
  });

  it("uses validated clone-owned resource names and pinned Worker Wrangler", () => {
    expect(workflow).toContain(
      "CLOUDFLARE_PAGES_PROJECT: ${{ vars.CLOUDFLARE_PAGES_PROJECT }}",
    );
    expect(workflow).toContain(
      "CLOUDFLARE_WORKER_NAME: ${{ vars.CLOUDFLARE_WORKER_NAME }}",
    );
    expect(workflow).toContain(
      "corepack pnpm --dir apps/worker exec wrangler pages deploy apps/web/dist",
    );
    expect(workflow).toContain("--cwd ../..");
    expect(workflow).not.toContain("--project-name postline --branch main");
    expect(workflow).not.toContain("cache: pnpm");
  });

  it("passes no server-only secret into a Vite variable", () => {
    const viteSecretMappings = [
      ...workflow.matchAll(
        /^\s+(VITE_[A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) \}\}$/gm,
      ),
    ].map((match) => [match[1], match[2]]);

    expect(viteSecretMappings).toEqual([
      ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"],
      ["VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"],
    ]);
  });

  it("pins executable actions to immutable commit SHAs", () => {
    const actionReferences = [workflow, ciWorkflow].flatMap((contents) =>
      [...contents.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]),
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  it("keeps real publishing and automatic queue retries disabled", () => {
    expect(wrangler).toMatch(/^LIVE_TEST_CONFIRM = "false"$/m);
    expect(wrangler).toMatch(/^META_APP_REVIEW_APPROVED = "false"$/m);
    expect(wrangler).toMatch(/^TIKTOK_CONTENT_POSTING_AUDITED = "false"$/m);
    expect(wrangler).toMatch(/^YOUTUBE_API_AUDIT_APPROVED = "false"$/m);
    expect(wrangler).toMatch(/^max_retries = 0$/m);
  });
});
