import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/deploy.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);
const rehearsalWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/meta-review-rehearsal.yml"),
  "utf8",
);
const wrangler = readFileSync(
  resolve(process.cwd(), "apps/worker/wrangler.toml"),
  "utf8",
);
const wranglerConfig = parse(wrangler) as Record<string, unknown>;
const wranglerSchema = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "apps/worker/node_modules/wrangler/config-schema.json",
    ),
    "utf8",
  ),
) as {
  definitions: {
    Observability: {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
  };
};
const variables = wranglerConfig.vars as Record<string, unknown>;
const observability = wranglerConfig.observability as {
  enabled: boolean;
  redact_query_string: boolean;
  logs: { enabled: boolean; invocation_logs: boolean };
  traces: { enabled: boolean };
};

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
    expect(workflow.match(/VITE_TURNSTILE_SITE_KEY:/g)).toHaveLength(2);
    expect(workflow).toContain(
      "VITE_TURNSTILE_SITE_KEY: ${{ vars.VITE_TURNSTILE_SITE_KEY }}",
    );
    expect(workflow).not.toMatch(/VITE_TURNSTILE_SITE_KEY: \$\{\{ secrets\./);
  });

  it("pins executable actions to immutable commit SHAs", () => {
    const actionReferences = [workflow, ciWorkflow, rehearsalWorkflow].flatMap(
      (contents) =>
        [...contents.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]),
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[a-f0-9]{40}$/);
    }
  });

  it("keeps the Meta rehearsal manual, secret-free and non-deploying", () => {
    expect(rehearsalWorkflow).toContain("workflow_dispatch:");
    expect(rehearsalWorkflow).not.toMatch(
      /^\s{2}(push|pull_request|schedule):/m,
    );
    expect(rehearsalWorkflow).not.toMatch(/\bsecrets:/i);
    expect(rehearsalWorkflow).not.toMatch(/^\s+environment:/m);
    expect(rehearsalWorkflow).not.toMatch(
      /wrangler\s+(?:deploy|versions|secret)|pages\s+deploy/i,
    );
    expect(rehearsalWorkflow).toContain("corepack pnpm exec supabase start");
    expect(rehearsalWorkflow).toContain("corepack pnpm db:test");
    expect(rehearsalWorkflow).toContain("corepack pnpm db:integration");
    expect(rehearsalWorkflow).toContain("corepack pnpm meta-review:rehearsal");
  });

  it("keeps real publishing disabled and queue recovery bounded", () => {
    expect(variables).toMatchObject({
      LIVE_TEST_CONFIRM: "false",
      META_APP_REVIEW_APPROVED: "false",
      META_REVIEW_MODE: "false",
      TIKTOK_CONTENT_POSTING_AUDITED: "false",
      YOUTUBE_API_AUDIT_APPROVED: "false",
    });
    expect(wranglerConfig.queues).toMatchObject({
      consumers: [
        {
          max_retries: 5,
          dead_letter_queue: "social-scheduler-dead-letter",
        },
      ],
    });
    expect(observability.redact_query_string).toBe(true);
  });

  it("disables automatic request logs and traces while retaining sanitized events", () => {
    expect(observability).toMatchObject({
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, invocation_logs: false },
      traces: { enabled: false },
    });
    const supported = wranglerSchema.definitions.Observability.properties;
    expect(supported).toHaveProperty("redact_query_string");
    expect(supported.logs?.properties).toHaveProperty("invocation_logs");
    expect(supported.traces?.properties).toHaveProperty("enabled");
  });

  it("executes migrations in disposable Supabase and gates Worker deployment", () => {
    expect(ciWorkflow).toContain("corepack pnpm exec supabase start");
    expect(ciWorkflow).toContain("corepack pnpm db:test");
    expect(ciWorkflow).toContain("corepack pnpm db:integration");
    const previousSchema = ciWorkflow.indexOf(
      "mv supabase/migrations/202609070009_analytics_generation_isolation.sql",
    );
    const disposableStart = ciWorkflow.indexOf(
      "corepack pnpm exec supabase start",
    );
    const forwardUpgrade = ciWorkflow.indexOf(
      "corepack pnpm exec supabase migration up --local",
    );
    const databaseTests = ciWorkflow.indexOf("corepack pnpm db:test");
    expect(previousSchema).toBeGreaterThan(0);
    expect(disposableStart).toBeGreaterThan(previousSchema);
    expect(forwardUpgrade).toBeGreaterThan(disposableStart);
    expect(databaseTests).toBeGreaterThan(forwardUpgrade);
    expect(ciWorkflow).toContain(
      "corepack pnpm exec supabase stop --no-backup",
    );
    const migrationGate = workflow.indexOf(
      "corepack pnpm db:verify:production",
    );
    const workerDeploy = workflow.indexOf("Deploy Worker");
    expect(migrationGate).toBeGreaterThan(0);
    expect(workerDeploy).toBeGreaterThan(migrationGate);
    expect(workflow).toContain(
      "SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
    );
  });
});
