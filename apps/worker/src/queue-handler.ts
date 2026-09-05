import type { Env, QueueJob } from "./env";
import { logWorkerError } from "./logging";
import { processQueueJob } from "./publisher";
import {
  QueueInfrastructureError,
  type QueueProcessResult,
} from "./queue-errors";

export const QUEUE_MAX_RETRIES = 5;
export const QUEUE_MAX_DELIVERY_ATTEMPTS = QUEUE_MAX_RETRIES + 1;

interface QueueMessage {
  id: string;
  attempts: number;
  body: QueueJob;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

type QueueProcessor = (env: Env, job: QueueJob) => Promise<QueueProcessResult>;

export async function handleQueueMessage(
  env: Env,
  message: QueueMessage,
  processor: QueueProcessor = processQueueJob,
): Promise<{
  action: "ack" | "retry" | "dlq";
  result?: QueueProcessResult;
}> {
  try {
    const result = await processor(env, message.body);
    message.ack();
    return { action: "ack", result };
  } catch (error) {
    const context =
      error instanceof QueueInfrastructureError
        ? error
        : new QueueInfrastructureError(message.body);
    const exhausted = message.attempts >= QUEUE_MAX_DELIVERY_ATTEMPTS;
    logWorkerError(exhausted ? "queue_retry_exhausted" : "queue_job_retrying", {
      targetId: message.body.targetId,
      messageId: message.id,
      attempt: message.attempts,
      ...(context.provider ? { provider: context.provider } : {}),
      state: context.targetState ?? message.body.mode,
      classification: context.classification,
    });
    message.retry({
      delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900),
    });
    return { action: exhausted ? "dlq" : "retry" };
  }
}
