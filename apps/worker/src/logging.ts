export type WorkerErrorCode =
  | "request_failed"
  | "queue_dispatch_failed"
  | "queue_job_failed"
  | "media_retention_update_failed";

interface WorkerErrorContext {
  requestId?: string;
  targetId?: string;
}

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;

export function formatWorkerError(
  code: WorkerErrorCode,
  context: WorkerErrorContext = {},
): string {
  const record: Record<string, string> = { level: "error", message: code };
  if (context.requestId && SAFE_IDENTIFIER.test(context.requestId)) {
    record.requestId = context.requestId;
  }
  if (context.targetId && SAFE_IDENTIFIER.test(context.targetId)) {
    record.targetId = context.targetId;
  }
  return JSON.stringify(record);
}

export function logWorkerError(
  code: WorkerErrorCode,
  context: WorkerErrorContext = {},
): void {
  console.error(formatWorkerError(code, context));
}
