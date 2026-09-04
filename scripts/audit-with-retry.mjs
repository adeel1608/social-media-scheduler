import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const AUDIT_ATTEMPT_TIMEOUT_MS = 180_000;

export function runAuditWithRetry({
  spawn = spawnSync,
  platform = process.platform,
  timeoutMs = AUDIT_ATTEMPT_TIMEOUT_MS,
  report = console.error,
} = {}) {
  const command =
    platform === "win32"
      ? {
          executable: "cmd.exe",
          args: ["/d", "/s", "/c", "corepack pnpm audit --audit-level high"],
        }
      : {
          executable: "corepack",
          args: ["pnpm", "audit", "--audit-level", "high"],
        };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = spawn(command.executable, command.args, {
      stdio: "inherit",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
    const timedOut = result.error?.code === "ETIMEDOUT";
    if (result.error && !timedOut) throw result.error;
    if (result.status === 0) return 0;
    if (timedOut) {
      report(
        `Dependency audit attempt ${attempt} timed out after ${Math.round(timeoutMs / 1_000)} seconds.`,
      );
    }
    if (attempt === 1) {
      report(
        "Dependency audit failed. Retrying once in case the advisory service is temporarily unavailable.",
      );
    } else {
      return result.status ?? 1;
    }
  }
  return 1;
}

const directRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (directRun) {
  process.exitCode = runAuditWithRetry();
}
