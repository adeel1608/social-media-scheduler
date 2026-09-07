import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const status = spawnSync(pnpm, ["exec", "supabase", "status", "-o", "env"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (status.status !== 0) {
  console.error(
    "Disposable Supabase is not running; integration tests were not executed.",
  );
  process.exit(1);
}
const values = new Map();
for (const line of status.stdout.split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!match) continue;
  values.set(match[1], match[2].replace(/^['"]|['"]$/g, ""));
}
const apiUrl = values.get("API_URL");
const anonKey = values.get("ANON_KEY") ?? values.get("PUBLISHABLE_KEY");
const serviceKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
if (
  !apiUrl ||
  !anonKey ||
  !serviceKey ||
  !/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(apiUrl)
) {
  console.error(
    "Disposable Supabase status did not contain a safe loopback test configuration.",
  );
  process.exit(1);
}
const run = spawnSync(
  pnpm,
  ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      POSTLINE_TEST_SUPABASE_URL: apiUrl,
      POSTLINE_TEST_SUPABASE_ANON_KEY: anonKey,
      POSTLINE_TEST_SUPABASE_SERVICE_KEY: serviceKey,
    },
  },
);
process.exit(run.status ?? 1);
