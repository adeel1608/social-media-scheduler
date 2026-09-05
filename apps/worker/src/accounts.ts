import type { Platform } from "@scheduler/shared";

type ConnectedAccountRecord = Record<string, unknown>;

export interface SanitizedConnectedAccount {
  id: string;
  platform: Platform;
  username: string | null;
  connection_status:
    "connected" | "expired" | "revoked" | "error" | "disconnected";
  approval_state: "approved" | "pending" | "not_required" | "rejected";
  requires_reconnect: boolean;
  metadata: {
    displayName?: string;
    accountType?: string;
  };
}

const platforms = new Set<Platform>(["instagram", "tiktok", "youtube"]);
const connectionStatuses = new Set<
  SanitizedConnectedAccount["connection_status"]
>(["connected", "expired", "revoked", "error", "disconnected"]);
const approvalStates = new Set<SanitizedConnectedAccount["approval_state"]>([
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
    !approvalStates.has(
      record.approval_state as SanitizedConnectedAccount["approval_state"],
    )
  ) {
    return null;
  }
  const status =
    record.connection_status as SanitizedConnectedAccount["connection_status"];
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};
  const displayName = boundedText(metadata.displayName, 200);
  const accountType = boundedText(metadata.accountType, 100);
  return {
    id: record.id,
    platform: record.platform as Platform,
    username: boundedText(record.username, 200) ?? null,
    connection_status: status,
    approval_state:
      record.approval_state as SanitizedConnectedAccount["approval_state"],
    requires_reconnect: status !== "connected",
    metadata: {
      ...(displayName ? { displayName } : {}),
      ...(accountType ? { accountType } : {}),
    },
  };
}
