import type { Platform } from "@scheduler/shared";

const labels: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
};
const marks: Record<Platform, string> = {
  instagram: "IG",
  tiktok: "TT",
  youtube: "YT",
};

export function PlatformBadge({
  platform,
  compact = false,
}: {
  platform: Platform;
  compact?: boolean;
}) {
  return (
    <span
      className={`platform-badge platform-${platform} ${compact ? "compact" : ""}`}
    >
      <span>{marks[platform]}</span>
      {!compact && labels[platform]}
    </span>
  );
}
