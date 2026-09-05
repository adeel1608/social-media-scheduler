import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const serverSecretSentinels = {
  SUPABASE_SERVICE_ROLE_KEY: "POSTLINE_TEST_SERVICE_ROLE_MUST_NOT_APPEAR_7A4D",
  TOKEN_ENCRYPTION_KEY: "POSTLINE_TEST_ENCRYPTION_KEY_MUST_NOT_APPEAR_7A4D",
  UPLOADTHING_TOKEN: "POSTLINE_TEST_UPLOAD_TOKEN_MUST_NOT_APPEAR_7A4D",
  RESEND_API_KEY: "POSTLINE_TEST_RESEND_KEY_MUST_NOT_APPEAR_7A4D",
  META_APP_SECRET: "POSTLINE_TEST_META_SECRET_MUST_NOT_APPEAR_7A4D",
  TIKTOK_CLIENT_SECRET: "POSTLINE_TEST_TIKTOK_SECRET_MUST_NOT_APPEAR_7A4D",
  GOOGLE_CLIENT_SECRET: "POSTLINE_TEST_GOOGLE_SECRET_MUST_NOT_APPEAR_7A4D",
  CLOUDFLARE_API_TOKEN: "POSTLINE_TEST_CLOUDFLARE_TOKEN_MUST_NOT_APPEAR_7A4D",
};
const buildCommand =
  process.platform === "win32"
    ? {
        command: "cmd.exe",
        arguments: ["/d", "/s", "/c", "corepack pnpm -r --if-present build"],
      }
    : {
        command: "corepack",
        arguments: ["pnpm", "-r", "--if-present", "build"],
      };
const result = spawnSync(buildCommand.command, buildCommand.arguments, {
  cwd: resolve("."),
  env: {
    ...process.env,
    VITE_DEMO_MODE: "false",
    VITE_APP_URL: "https://postline-ci.pages.dev",
    VITE_API_URL: "https://postline-ci.workers.dev",
    VITE_SUPABASE_URL: "https://postline-ci.supabase.co",
    VITE_SUPABASE_ANON_KEY:
      "sb_publishable_CI_ONLY_NOT_A_CREDENTIAL_1234567890",
    VITE_OPERATOR_NAME: "Postline CI",
    VITE_PUBLIC_CONTACT_EMAIL: "ci-contact@postline.dev",
    ...serverSecretSentinels,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const distDirectory = resolve("apps/web/dist");
const bundleFiles = await listFiles(distDirectory);
const sourceMaps = bundleFiles.filter((file) => file.endsWith(".map"));
if (sourceMaps.length > 0) {
  throw new Error(
    `Production web build emitted ${sourceMaps.length} downloadable source map(s)`,
  );
}
for (const file of bundleFiles) {
  if (!/[.](?:css|html|js|map)$/.test(file)) continue;
  const contents = await readFile(file, "utf8");
  for (const [name, sentinel] of Object.entries(serverSecretSentinels)) {
    if (contents.includes(sentinel)) {
      throw new Error(
        `${name} server-only sentinel was included in the web bundle: ${file}`,
      );
    }
  }
}

const headers = await readFile(resolve(distDirectory, "_headers"), "utf8");
if (/connect-src[^;\n]*\shttps:(?:\s|;)/.test(headers)) {
  throw new Error("Production Pages CSP permits arbitrary HTTPS connections");
}
for (const expectedOrigin of [
  "https://postline-ci.workers.dev",
  "https://postline-ci.supabase.co",
  "https://*.ingest.uploadthing.com",
]) {
  if (!headers.includes(expectedOrigin)) {
    throw new Error(`Production Pages CSP is missing ${expectedOrigin}`);
  }
}

console.log(
  `Production web build passed with validated public configuration, no source maps, and ${bundleFiles.length} output files containing none of ${Object.keys(serverSecretSentinels).length} server-secret sentinels.`,
);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}
