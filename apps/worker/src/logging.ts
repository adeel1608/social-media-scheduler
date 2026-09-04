import { configurationKeys, type Env } from "./env";

export type WorkerErrorCode =
  | "configuration_incomplete"
  | "request_failed"
  | "queue_dispatch_failed"
  | "queue_job_failed"
  | "media_retention_update_failed";

interface WorkerErrorContext {
  requestId?: string;
  targetId?: string;
  missingKeys?: ReadonlyArray<keyof Env>;
  invalidKeys?: ReadonlyArray<keyof Env>;
}

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_CONFIGURATION_KEYS = new Set<keyof Env>(configurationKeys);

export function formatWorkerError(
  code: WorkerErrorCode,
  context: WorkerErrorContext = {},
): string {
  const record: Record<string, string | Array<keyof Env>> = {
    level: "error",
    message: code,
  };
  if (context.requestId && SAFE_IDENTIFIER.test(context.requestId)) {
    record.requestId = context.requestId;
  }
  if (context.targetId && SAFE_IDENTIFIER.test(context.targetId)) {
    record.targetId = context.targetId;
  }
  for (const [field, keys] of [
    ["missingKeys", context.missingKeys],
    ["invalidKeys", context.invalidKeys],
  ] as const) {
    const safeKeys = [
      ...new Set(keys?.filter((key) => SAFE_CONFIGURATION_KEYS.has(key))),
    ];
    if (safeKeys.length > 0) record[field] = safeKeys;
  }
  return JSON.stringify(record);
}

export function logWorkerError(
  code: WorkerErrorCode,
  context: WorkerErrorContext = {},
): void {
  console.error(formatWorkerError(code, context));
}
