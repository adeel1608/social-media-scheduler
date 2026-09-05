import type { Platform, PublishResult } from "@scheduler/shared";

import type { QueueJob } from "./env";

export type QueueProcessingClassification =
  | "success"
  | "validation_or_authorization_failure"
  | "definite_provider_rejection"
  | "ambiguous_provider_acceptance"
  | "duplicate_delivery"
  | "safe_continuation";

export interface QueueProcessResult {
  classification: QueueProcessingClassification;
  provider?: Platform;
  state: string;
}

export class QueueInfrastructureError extends Error {
  readonly classification = "retryable_infrastructure" as const;

  constructor(
    readonly job: QueueJob,
    readonly provider?: Platform,
    readonly targetState?: string,
  ) {
    super("Queue processing encountered a retryable infrastructure failure.");
    this.name = "QueueInfrastructureError";
  }
}

export function classifyPublishResult(
  result: PublishResult,
): QueueProcessingClassification {
  if (result.outcome === "ambiguous") return "ambiguous_provider_acceptance";
  if (result.outcome === "failed") return "definite_provider_rejection";
  if (result.outcome === "processing") return "safe_continuation";
  return "success";
}
