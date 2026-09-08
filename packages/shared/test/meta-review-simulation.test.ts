import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");
const productionEntrypoint = read("apps/web/src/main.tsx");
const authContext = read("apps/web/src/context/AuthContext.tsx");
const simulationEntrypoint = read(
  "apps/web/e2e/meta-review-simulation/main.tsx",
);
const simulationSpec = read(
  "apps/web/e2e/meta-review-simulation/meta-review-simulation.spec.ts",
);
const buildVerifier = read("scripts/verify-production-build.mjs");
const rehearsalGenerator = read("scripts/generate-meta-review-rehearsal.mjs");
const workerSource = [
  "access.ts",
  "auth.ts",
  "index.ts",
  "oauth-routes.ts",
  "publisher.ts",
  "uploadthing.ts",
]
  .map((file) => read(`apps/worker/src/${file}`))
  .join("\n");
const defaults = `${read(".env.example")}\n${read("apps/worker/wrangler.toml")}`;
const gitignore = read(".gitignore");

describe("Meta review rehearsal isolation", () => {
  it("keeps the injectable adapter absent from the production entrypoint", () => {
    expect(authContext).toContain("testAdapter?: AuthTestAdapter");
    expect(productionEntrypoint).not.toContain("AuthTestAdapter");
    expect(productionEntrypoint).not.toContain("testAdapter=");
    expect(productionEntrypoint).not.toContain("SIMULATION_ONLY_");
    expect(simulationEntrypoint).toContain("testAdapter={adapter}");
  });

  it("adds no simulation endpoint or activation flag to the Worker", () => {
    expect(workerSource).not.toMatch(/\/simulation(?:\/|\b)/);
    expect(workerSource).not.toContain("META_REVIEW_SIMULATION");
    expect(workerSource).not.toContain("SIMULATION_ONLY_");
  });

  it("fails production builds if any rehearsal sentinel is bundled", () => {
    for (const sentinel of [
      "meta.reviewer@postline.example.test",
      "owner@postline.example.test",
      "postline_review_demo",
      "SIMULATION_ONLY_",
      "SIMULATION — NOT FOR META SUBMISSION",
      "/simulation/internal/",
      "IG_SIMULATION_ACCOUNT_0001",
    ]) {
      expect(buildVerifier).toContain(JSON.stringify(sentinel));
    }
  });

  it("blocks every non-localhost browser request and uses runtime credentials", () => {
    expect(simulationSpec).toContain('page.route("**/*"');
    expect(simulationSpec).toContain('route.abort("blockedbyclient")');
    expect(simulationSpec).toContain("externalAttempts.push");
    expect(simulationSpec).toContain("randomBytes(24)");
    expect(simulationSpec).not.toMatch(/const password\s*=\s*["'][^"']+["']/);
  });

  it("keeps generated recordings ignored", () => {
    expect(gitignore).toMatch(/^artifacts\/$/m);
  });

  it("runs the real publication and Instagram adapter state-machine tests", () => {
    expect(rehearsalGenerator).toContain(
      "apps/worker/test/publisher-state-machine.test.ts",
    );
    expect(rehearsalGenerator).toContain(
      "packages/platforms/test/adapters.test.ts",
    );
  });

  it("keeps every production safety flag false", () => {
    for (const name of [
      "LIVE_TEST_CONFIRM",
      "META_APP_REVIEW_APPROVED",
      "META_REVIEW_MODE",
      "VITE_META_REVIEW_MODE",
      "TIKTOK_CONTENT_POSTING_AUDITED",
      "YOUTUBE_API_AUDIT_APPROVED",
    ]) {
      expect(defaults).toMatch(new RegExp(`${name}\\s*=\\s*["']?false["']?`));
    }
  });
});
