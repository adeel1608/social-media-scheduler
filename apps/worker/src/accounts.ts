import type { Platform } from "@scheduler/shared";

import type { Env } from "./env";

type ConnectedAccountRecord = Record<string, unknown>;
type ApprovalState = "approved" | "pending" | "not_required" | "rejected";
type ProviderApprovalEnvironment = Pick<
  Env,
  | "META_APP_REVIEW_APPROVED"
  | "TIKTOK_CONTENT_POSTING_AUDITED"
  | "YOUTUBE_API_AUDIT_APPROVED"
>;

export interface SanitizedConnectedAccount {
  id: string;
  platform: Platform;
  username: string | null;
  connection_status:
    "connected" | "expired" | "revoked" | "error" | "disconnected";
  /** Effective current state derived from the Worker environment. */
  approval_state: "approved" | "pending";
  /** Historical state persisted when the connection was last established. */
  stored_approval_state: ApprovalState;
  requires_reconnect: boolean;
  metadata: {
    displayName?: string;
    accountType?: string;
  };
  disconnect_cleanup?: {
    operationId: string;
    state:
      | "prepared"
      | "revocation_started"
      | "provider_revoked"
      | "revocation_uncertain";
    expiresAt: string;
    providerRevoked: boolean;
    revocationUncertain: boolean;
  };
}

const platforms = new Set<Platform>(["instagram", "tiktok", "youtube"]);
const connectionStatuses = new Set<
  SanitizedConnectedAccount["connection_status"]
>(["connected", "expired", "revoked", "error", "disconnected"]);
const approvalStates = new Set<ApprovalState>([
  "approved",
  "pending",
  "not_required",
  "rejected",
]);

function boundedText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximum)
    : undefined;
}

export function sanitizeConnectedAccount(
  record: ConnectedAccountRecord,
  approvalEnvironment: ProviderApprovalEnvironment,
): SanitizedConnectedAccount | null {
  if (
    typeof record.id !== "string" ||
    typeof record.platform !== "string" ||
    !platforms.has(record.platform as Platform) ||
    typeof record.connection_status !== "string" ||
    !connectionStatuses.has(
      record.connection_status as SanitizedConnectedAccount["connection_status"],
    ) ||
    typeof record.approval_state !== "string" ||
    !approvalStates.has(record.approval_state as ApprovalState)
  ) {
    return null;
  }
  const status =
    record.connection_status as SanitizedConnectedAccount["connection_status"];
  const platform = record.platform as Platform;
  const storedApprovalState = record.approval_state as ApprovalState;
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};
  const displayName = boundedText(metadata.displayName, 200);
  const accountType = boundedText(metadata.accountType, 100);
  const cleanup =
    record.disconnect_cleanup && typeof record.disconnect_cleanup === "object"
      ? (record.disconnect_cleanup as Record<string, unknown>)
      : null;
  const cleanupState = cleanup?.state;
  const disconnectCleanup =
    cleanup &&
    typeof cleanup.operation_id === "string" &&
    typeof cleanupState === "string" &&
    [
      "prepared",
      "revocation_started",
      "provider_revoked",
      "revocation_uncertain",
    ].includes(cleanupState) &&
    typeof cleanup.expires_at === "string"
      ? {
          operationId: cleanup.operation_id,
          state: cleanupState as
            | "prepared"
            | "revocation_started"
            | "provider_revoked"
            | "revocation_uncertain",
          expiresAt: cleanup.expires_at,
          providerRevoked: cleanupState === "provider_revoked",
          revocationUncertain:
            cleanupState === "revocation_started" ||
            cleanupState === "revocation_uncertain",
        }
      : undefined;
  return {
    id: record.id,
    platform,
    username: boundedText(record.username, 200) ?? null,
    connection_status: status,
    approval_state: currentApprovalEnabled(platform, approvalEnvironment)
      ? "approved"
      : "pending",
    stored_approval_state: storedApprovalState,
    requires_reconnect: status !== "connected",
    metadata: {
      ...(displayName ? { displayName } : {}),
      ...(accountType ? { accountType } : {}),
    },
    ...(disconnectCleanup ? { disconnect_cleanup: disconnectCleanup } : {}),
  };
}

function currentApprovalEnabled(
  platform: Platform,
  environment: ProviderApprovalEnvironment,
): boolean {
  return {
    instagram: environment.META_APP_REVIEW_APPROVED === "true",
    tiktok: environment.TIKTOK_CONTENT_POSTING_AUDITED === "true",
    youtube: environment.YOUTUBE_API_AUDIT_APPROVED === "true",
  }[platform];
}
