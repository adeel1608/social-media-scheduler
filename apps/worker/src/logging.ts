import { configurationKeys, type Env } from "./env";

export type WorkerErrorCode =
  | "configuration_incomplete"
  | "request_failed"
  | "queue_dispatch_failed"
  | "queue_job_failed"
  | "queue_job_retrying"
  | "queue_retry_exhausted"
  | "queue_lease_release_failed"
  | "stale_queue_dispatch_failed"
  | "provider_revocation_incomplete"
  | "notification_reconciliation_failed"
  | "media_retention_update_failed";

interface WorkerErrorContext {
  requestId?: string;
  targetId?: string;
  messageId?: string;
  attempt?: number;
  provider?: string;
  state?: string;
  classification?: string;
  missingKeys?: ReadonlyArray<keyof Env>;
  invalidKeys?: ReadonlyArray<keyof Env>;
}

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_CONFIGURATION_KEYS = new Set<keyof Env>(configurationKeys);

export function formatWorkerError(
  code: WorkerErrorCode,
  context: WorkerErrorContext = {},
): string {
  const record: Record<string, string | number | Array<keyof Env>> = {
    level: "error",
    message: code,
  };
  if (context.requestId && SAFE_IDENTIFIER.test(context.requestId)) {
    record.requestId = context.requestId;
  }
  if (context.targetId && SAFE_IDENTIFIER.test(context.targetId)) {
    record.targetId = context.targetId;
  }
  if (context.messageId && SAFE_IDENTIFIER.test(context.messageId)) {
    record.messageId = context.messageId;
  }
  if (
    context.attempt !== undefined &&
    Number.isSafeInteger(context.attempt) &&
    context.attempt > 0 &&
    context.attempt <= 100
  ) {
    record.attempt = context.attempt;
  }
  if (context.provider && SAFE_IDENTIFIER.test(context.provider)) {
    record.provider = context.provider;
  }
  if (context.state && SAFE_IDENTIFIER.test(context.state)) {
    record.state = context.state;
  }
  if (context.classification && SAFE_IDENTIFIER.test(context.classification)) {
    record.classification = context.classification;
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
