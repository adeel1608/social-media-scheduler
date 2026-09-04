import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const serverSecretSentinel =
  "POSTLINE_TEST_SERVER_SECRET_MUST_NOT_APPEAR_IN_WEB_BUNDLE_7A4D";
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
    VITE_OPERATOR_NAME: "Postline CI",
    VITE_PUBLIC_CONTACT_EMAIL: "ci-contact@postline.dev",
    UPLOADTHING_TOKEN: serverSecretSentinel,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const distDirectory = resolve("apps/web/dist");
const bundleFiles = await listFiles(distDirectory);
for (const file of bundleFiles) {
  if (!/[.](?:css|html|js|map)$/.test(file)) continue;
  if ((await readFile(file, "utf8")).includes(serverSecretSentinel)) {
    throw new Error(
      `Server-only secret sentinel was included in the web bundle: ${file}`,
    );
  }
}

console.log(
  `Production web build passed with configured public identity; ${bundleFiles.length} output files contain no server-secret sentinel.`,
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
