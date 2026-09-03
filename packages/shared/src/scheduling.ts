import type {
  Platform,
  PostTarget,
  PublishResult,
  TargetStatus,
} from "./types";

export interface ConnectionState {
  connected: boolean;
  tokenValid: boolean;
  publicPublishingApproved: boolean;
}

export function eligibleStatus(
  target: Pick<PostTarget, "status" | "scheduledAtUtc">,
  connection: ConnectionState,
  now = new Date(),
): TargetStatus | null {
  if (!["scheduled", "blocked_authorization"].includes(target.status))
    return null;
  if (
    !connection.connected ||
    !connection.tokenValid ||
    !connection.publicPublishingApproved
  ) {
    return "blocked_authorization";
  }
  return new Date(target.scheduledAtUtc) <= now ? "queued" : "scheduled";
}

export interface ClaimableTarget {
  id: string;
  status: TargetStatus;
  scheduledAtUtc: string;
  leaseExpiresAt?: string;
}

export function claimDueTargets(
  targets: ClaimableTarget[],
  now = new Date(),
  leaseSeconds = 300,
  limit = 100,
): ClaimableTarget[] {
  const claimed: ClaimableTarget[] = [];
  for (const target of targets) {
    if (claimed.length >= limit) break;
    const leaseExpired =
      !target.leaseExpiresAt || new Date(target.leaseExpiresAt) <= now;
    if (
      target.status === "scheduled" &&
      new Date(target.scheduledAtUtc) <= now &&
      leaseExpired
    ) {
      target.status = "queued";
      target.leaseExpiresAt = new Date(
        now.getTime() + leaseSeconds * 1_000,
      ).toISOString();
      claimed.push(target);
    }
  }
  return claimed;
}

export function applyPublishResult(
  target: PostTarget,
  result: PublishResult,
): PostTarget {
  if (result.outcome === "ambiguous") {
    return {
      ...target,
      status: "needs_review",
      errorCode: result.error?.code ?? "ambiguous_response",
      errorMessage:
        result.error?.message ?? "The platform response was ambiguous.",
    };
  }
  if (result.outcome === "failed") {
    return {
      ...target,
      status: "failed",
      errorCode: result.error?.code ?? "publish_failed",
      errorMessage:
        result.error?.message ?? "The platform rejected the publish request.",
    };
  }
  return {
    ...target,
    status: result.outcome,
    ...(result.remoteContentId
      ? { remoteContentId: result.remoteContentId }
      : {}),
    ...(result.remoteUrl ? { remoteUrl: result.remoteUrl } : {}),
  };
}

export function canManualRetry(status: TargetStatus): boolean {
  return status === "failed";
}

export function queueDeliveryAction(_result: PublishResult): "ack" {
  // API failures are recorded and acknowledged. Cloudflare Queues must not retry them.
  return "ack";
}

export function notificationDeduplicationKey(
  targetId: string,
  attemptNumber: number,
): string {
  return `failure:${targetId}:attempt:${attemptNumber}`;
}

export function mediaDeletionEligible(
  statuses: TargetStatus[],
  allPublishedAt: string | null,
  now = new Date(),
): boolean {
  if (
    statuses.length === 0 ||
    statuses.some((status) => status !== "published")
  )
    return false;
  if (!allPublishedAt) return false;
  return (
    now.getTime() - new Date(allPublishedAt).getTime() >=
    7 * 24 * 60 * 60 * 1_000
  );
}

export interface UploadSession {
  platform: Platform;
  sessionUrl: string;
  nextByte: number;
  totalBytes: number;
  publishRequestCreated: boolean;
}

export function continueResumableUpload(
  session: UploadSession,
  uploadedBytes: number,
): UploadSession {
  if (
    uploadedBytes < 0 ||
    session.nextByte + uploadedBytes > session.totalBytes
  ) {
    throw new Error("Invalid resumable upload range");
  }
  return { ...session, nextByte: session.nextByte + uploadedBytes };
}
