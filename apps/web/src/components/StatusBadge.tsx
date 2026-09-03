const label: Record<string, string> = {
  scheduled: "Scheduled",
  blocked_authorization: "Approval blocked",
  queued: "Queued",
  publishing: "Publishing",
  processing: "Processing",
  published: "Published",
  failed: "Failed",
  needs_review: "Needs review",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-${status}`}>
      {label[status] ?? status}
    </span>
  );
}
