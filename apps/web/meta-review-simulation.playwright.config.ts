import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = dirname(fileURLToPath(import.meta.url));
const artifactDirectory =
  process.env.POSTLINE_REHEARSAL_DIR ??
  resolve(webDirectory, "../../artifacts/meta-review-rehearsal/uncommitted");

export default defineConfig({
  testDir: "./e2e/meta-review-simulation",
  testMatch: "meta-review-simulation.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: resolve(artifactDirectory, "playwright-output"),
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: resolve(artifactDirectory, "playwright-report"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:4174",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "light",
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "corepack pnpm exec vite --config e2e/meta-review-simulation/vite.config.ts",
    cwd: webDirectory,
    url: "http://127.0.0.1:4174/login?review=meta",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
