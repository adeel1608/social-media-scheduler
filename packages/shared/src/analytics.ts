import type { NormalizedMetric, Platform } from "./types";

const mapping: Record<Platform, Record<string, NormalizedMetric["name"]>> = {
  instagram: {
    views: "views",
    reach: "reach",
    impressions: "impressions",
    likes: "likes",
    comments: "comments",
    shares: "shares",
    saved: "saves",
    like_count: "likes",
    comments_count: "comments",
  },
  tiktok: {
    view_count: "views",
    like_count: "likes",
    comment_count: "comments",
    share_count: "shares",
    follower_count_delta: "followers_delta",
  },
  youtube: {
    views: "views",
    likes: "likes",
    comments: "comments",
    shares: "shares",
    estimatedMinutesWatched: "watch_time_minutes",
    averageViewDuration: "average_view_duration_seconds",
    subscribersGained: "followers_delta",
  },
};

export const comparableMetrics: NormalizedMetric["name"][] = [
  "views",
  "reach",
  "impressions",
  "likes",
  "comments",
  "shares",
  "saves",
  "watch_time_minutes",
  "average_view_duration_seconds",
  "followers_delta",
];

export function normalizeAnalytics(
  platform: Platform,
  raw: Record<string, number | null | undefined>,
): NormalizedMetric[] {
  const normalized = new Map<NormalizedMetric["name"], NormalizedMetric>();
  for (const [rawName, value] of Object.entries(raw)) {
    const name = mapping[platform][rawName];
    if (!name) continue;
    normalized.set(name, {
      name,
      value: typeof value === "number" ? value : null,
      available: typeof value === "number",
      rawName,
    });
  }
  return comparableMetrics.map(
    (name) => normalized.get(name) ?? { name, value: null, available: false },
  );
}

export function engagementRate(metrics: NormalizedMetric[]): number | null {
  const get = (name: NormalizedMetric["name"]) =>
    metrics.find((item) => item.name === name);
  const views = get("views");
  if (!views?.available || !views.value) return null;
  const interactions = ["likes", "comments", "shares", "saves"].reduce(
    (sum, name) => {
      const metric = get(name as NormalizedMetric["name"]);
      return sum + (metric?.available ? (metric.value ?? 0) : 0);
    },
    0,
  );
  return (interactions / views.value) * 100;
}
