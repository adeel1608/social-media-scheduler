import { spawnSync } from "node:child_process";

const command =
  process.platform === "win32"
    ? {
        executable: "cmd.exe",
        args: ["/d", "/s", "/c", "corepack pnpm audit --audit-level high"],
      }
    : {
        executable: "corepack",
        args: ["pnpm", "audit", "--audit-level", "high"],
      };

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const result = spawnSync(command.executable, command.args, {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status === 0) process.exit(0);
  if (attempt === 1) {
    console.error(
      "Dependency audit failed. Retrying once in case the advisory service is temporarily unavailable.",
    );
  } else {
    process.exit(result.status ?? 1);
  }
}
