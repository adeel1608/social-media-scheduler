import {
  ArrowRight,
  CalendarRange,
  ChevronDown,
  Eye,
  Heart,
  MousePointer2,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

const demoChart = [38, 46, 41, 58, 55, 67, 61, 73, 69, 82, 78, 92, 87, 96];
const demoPosts = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Designing a calmer Monday",
    type: "Carousel",
    platform: "instagram" as const,
    views: "18.4k",
    rate: "8.7%",
    tone: "coral",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "Colour study no. 14",
    type: "Video · 00:28",
    platform: "tiktok" as const,
    views: "12.8k",
    rate: "6.2%",
    tone: "lilac",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "A complete creative reset",
    type: "Video · 11:42",
    platform: "youtube" as const,
    views: "9.7k",
    rate: "5.4%",
    tone: "blue",
  },
];

interface AnalyticsSnapshot {
  id: string;
  post_target_id: string;
  platform: "instagram" | "tiktok" | "youtube";
  captured_at: string;
  normalized_metrics: Record<string, number | null>;
  unavailable_metrics: string[];
  post_targets: {
    metadata: { contentType?: string };
    remote_url?: string;
    posts: { title: string };
  };
}

export function AnalyticsPage() {
  const { demoMode, session } = useAuth();
  const [snapshots, setSnapshots] = useState<AnalyticsSnapshot[]>([]);
  const [platformFilter, setPlatformFilter] = useState("all");
  const [contentFilter, setContentFilter] = useState("all");
  const [rangeDays, setRangeDays] = useState(28);
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);

  async function loadAnalytics() {
    if (demoMode || !session) return;
    const end = new Date();
    const start = new Date(end.getTime() - rangeDays * 86_400_000);
    const parameters = new URLSearchParams({
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    });
    if (platformFilter !== "all") parameters.set("platform", platformFilter);
    try {
      const result = await apiRequest<{ data: AnalyticsSnapshot[] }>(
        `/api/analytics?${parameters}`,
        session,
      );
      setSnapshots(result.data);
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Analytics could not be loaded.",
      );
    }
  }

  useEffect(() => {
    void loadAnalytics();
  }, [demoMode, session, platformFilter, rangeDays]);

  const latest = useMemo(() => {
    const seen = new Set<string>();
    return snapshots.filter((snapshot) => {
      if (seen.has(snapshot.post_target_id)) return false;
      seen.add(snapshot.post_target_id);
      if (contentFilter === "all") return true;
      return snapshot.post_targets.metadata.contentType?.includes(
        contentFilter,
      );
    });
  }, [contentFilter, snapshots]);
  const sum = (name: string) =>
    latest.reduce(
      (total, snapshot) => total + (snapshot.normalized_metrics[name] ?? 0),
      0,
    );
  const available = (name: string) =>
    latest.some(
      (snapshot) =>
        !snapshot.unavailable_metrics.includes(name) &&
        snapshot.normalized_metrics[name] !== null &&
        snapshot.normalized_metrics[name] !== undefined,
    );
  const views = sum("views");
  const engagementMetricNames = ["likes", "comments", "shares", "saves"];
  const engagements = engagementMetricNames.reduce(
    (total, metric) => total + sum(metric),
    0,
  );
  const engagementMetricsAvailable = engagementMetricNames.some(available);
  const rate = views ? (engagements / views) * 100 : null;
  const realPosts = latest.slice(0, 5).map((snapshot) => ({
    id: snapshot.post_target_id,
    title: snapshot.post_targets.posts.title,
    type: snapshot.post_targets.metadata.contentType ?? "Content",
    platform: snapshot.platform,
    views: availableForSnapshot(snapshot, "views")
      ? formatNumber(snapshot.normalized_metrics.views ?? 0)
      : "Not provided",
    rate: engagementRate(snapshot),
    tone:
      snapshot.platform === "instagram"
        ? "coral"
        : snapshot.platform === "tiktok"
          ? "lilac"
          : "blue",
  }));
  const chart = demoMode ? demoChart : chartValues(snapshots, contentFilter);
  const chartLabels = dateRangeLabels(rangeDays);
  const posts = demoMode ? demoPosts : realPosts;
  const platformViews = (platform: AnalyticsSnapshot["platform"]) =>
    latest
      .filter((snapshot) => snapshot.platform === platform)
      .reduce(
        (total, snapshot) => total + (snapshot.normalized_metrics.views ?? 0),
        0,
      );

  async function syncAnalytics() {
    if (demoMode || !session) {
      setMessage("Demonstration data is fixed; no provider request was sent.");
      return;
    }
    setSyncing(true);
    try {
      const result = await apiRequest<{ synced: number }>(
        "/api/analytics/sync",
        session,
        { method: "POST" },
      );
      setMessage(
        `Synced ${result.synced} published target${result.synced === 1 ? "" : "s"}.`,
      );
      await loadAnalytics();
    } catch (reason) {
      setMessage(
        reason instanceof Error ? reason.message : "Analytics sync failed.",
      );
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="dashboard-page">
      <section className="notice-strip">
        <span className="notice-icon">
          <Sparkles size={17} />
        </span>
        <div>
          <strong>
            {demoMode
              ? "2 services need your attention"
              : "Review connection and approval status"}
          </strong>
          <p>
            {demoMode
              ? "TikTok and YouTube public publishing are waiting for platform approval."
              : "The setup page reflects current server-side configuration without exposing secret values."}
          </p>
        </div>
        <Link to="/setup">
          Review setup <ArrowRight size={15} />
        </Link>
      </section>

      <section className="section-heading">
        <div>
          <h2>Performance at a glance</h2>
          <p>Selected reporting window: {rangeDays} days</p>
        </div>
        <div className="button-row">
          <label className="select-button">
            <CalendarRange size={16} />
            <select
              value={rangeDays}
              onChange={(event) => setRangeDays(Number(event.target.value))}
            >
              <option value={28}>Last 28 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
            <ChevronDown size={15} />
          </label>
          <label className="select-button">
            <select
              value={platformFilter}
              onChange={(event) => setPlatformFilter(event.target.value)}
              aria-label="Analytics platform"
            >
              <option value="all">All platforms</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="youtube">YouTube</option>
            </select>
          </label>
          <label className="select-button">
            <select
              value={contentFilter}
              onChange={(event) => setContentFilter(event.target.value)}
              aria-label="Analytics content type"
            >
              <option value="all">All content</option>
              <option value="video">Video</option>
              <option value="photo">Photo</option>
              <option value="carousel">Carousel</option>
              <option value="story">Story</option>
              <option value="short">Short</option>
            </select>
          </label>
          <button
            className="soft-button"
            onClick={() => void syncAnalytics()}
            disabled={syncing}
          >
            <RefreshCw size={15} /> {syncing ? "Syncing…" : "Sync analytics"}
          </button>
        </div>
      </section>

      <div className="metric-grid">
        <MetricCard
          icon={<Eye size={19} />}
          label="Total views"
          value={
            demoMode
              ? "41,286"
              : available("views")
                ? formatNumber(views)
                : "Not provided"
          }
          delta={demoMode ? "+18.2%" : "latest snapshots"}
          tone="peach"
        />
        <MetricCard
          icon={<Heart size={19} />}
          label="Engagements"
          value={
            demoMode
              ? "3,842"
              : engagementMetricsAvailable
                ? formatNumber(engagements)
                : "Not provided"
          }
          delta={demoMode ? "+12.4%" : "likes + comments + shares + saves"}
          tone="lilac"
        />
        <MetricCard
          icon={<Users size={19} />}
          label="Audience growth"
          value={
            demoMode
              ? "+684"
              : available("followers_delta")
                ? formatSigned(sum("followers_delta"))
                : "Not provided"
          }
          delta={demoMode ? "+8.1%" : "API availability varies"}
          tone="sage"
        />
        <MetricCard
          icon={<MousePointer2 size={19} />}
          label="Engagement rate"
          value={
            demoMode
              ? "9.31%"
              : rate === null
                ? "Not provided"
                : `${rate.toFixed(2)}%`
          }
          delta={demoMode ? "+0.7 pts" : "defined formula"}
          tone="gold"
        />
      </div>

      <div className="dashboard-grid">
        <section className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h3>Content reach</h3>
              <p>Views from published content</p>
            </div>
            <div className="legend">
              <span className="legend-dot indigo" /> All platforms
            </div>
          </div>
          <div
            className="chart-wrap"
            aria-label="Views trend over the last 28 days"
          >
            <div className="y-labels">
              <span>5k</span>
              <span>2.5k</span>
              <span>0</span>
            </div>
            <div className="bar-chart">
              {chart.map((value, index) => (
                <span
                  key={index}
                  style={{ height: `${value}%` }}
                  className={index === chart.length - 1 ? "highlight" : ""}
                />
              ))}
            </div>
            <div className="x-labels">
              {chartLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </div>
        </section>

        <section className="panel platform-panel">
          <div className="panel-heading">
            <div>
              <h3>By platform</h3>
              <p>Share of total views</p>
            </div>
          </div>
          <div className="platform-breakdown">
            {(["instagram", "tiktok", "youtube"] as const).map((platform) => {
              const value = demoMode
                ? { instagram: 20_300, tiktok: 12_800, youtube: 8_200 }[
                    platform
                  ]
                : platformViews(platform);
              const total = demoMode ? 41_300 : views;
              const metricAvailable = demoMode
                ? true
                : latest.some(
                    (snapshot) =>
                      snapshot.platform === platform &&
                      availableForSnapshot(snapshot, "views"),
                  );
              return (
                <PlatformRow
                  key={platform}
                  platform={platform}
                  value={metricAvailable ? formatNumber(value) : "Not provided"}
                  percent={total ? Math.round((value / total) * 100) : 0}
                />
              );
            })}
          </div>
          <p className="formula-note">
            <TrendingUp size={15} /> Engagement rate = (likes + comments +
            shares + saves) ÷ views × 100
          </p>
        </section>
      </div>

      <section className="panel recent-panel">
        <div className="panel-heading">
          <div>
            <h3>Top-performing posts</h3>
            <p>Published in the selected date range</p>
          </div>
          <Link to="/history">
            View all <ArrowRight size={15} />
          </Link>
        </div>
        <div className="post-table">
          <div className="table-head">
            <span>CONTENT</span>
            <span>PLATFORM</span>
            <span>VIEWS</span>
            <span>ENG. RATE</span>
            <span />
          </div>
          {posts.map((post) => (
            <div className="table-row" key={post.title}>
              <div className="content-cell">
                <span className={`thumb ${post.tone}`} />
                <div>
                  <strong>{post.title}</strong>
                  <small>{post.type}</small>
                </div>
              </div>
              <PlatformBadge platform={post.platform} />
              <strong>{post.views}</strong>
              <span className="positive">{post.rate}</span>
              <Link
                className="icon-button"
                aria-label={`Open ${post.title}`}
                to={`/analytics/${post.id}`}
              >
                <ArrowRight size={16} />
              </Link>
            </div>
          ))}
        </div>
      </section>
      {message && <p className="form-message">{message}</p>}
      <p className="data-note">
        Unavailable API metrics are shown as “Not provided”, never as zero.{" "}
        {demoMode
          ? "Analytics shown here is explicitly local demonstration data."
          : "Values come from the latest stored official-API snapshots in the selected range."}
      </p>
    </div>
  );
}

function availableForSnapshot(
  snapshot: AnalyticsSnapshot,
  metric: string,
): boolean {
  return (
    !snapshot.unavailable_metrics.includes(metric) &&
    snapshot.normalized_metrics[metric] !== null &&
    snapshot.normalized_metrics[metric] !== undefined
  );
}

function engagementRate(snapshot: AnalyticsSnapshot): string {
  const views = snapshot.normalized_metrics.views;
  if (!views || !availableForSnapshot(snapshot, "views")) return "Not provided";
  const engagements = ["likes", "comments", "shares", "saves"].reduce(
    (total, metric) => total + (snapshot.normalized_metrics[metric] ?? 0),
    0,
  );
  return `${((engagements / views) * 100).toFixed(2)}%`;
}

function chartValues(
  snapshots: AnalyticsSnapshot[],
  contentFilter: string,
): number[] {
  const totals = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (
      contentFilter !== "all" &&
      !snapshot.post_targets.metadata.contentType?.includes(contentFilter)
    )
      continue;
    const day = snapshot.captured_at.slice(0, 10);
    totals.set(
      day,
      (totals.get(day) ?? 0) + (snapshot.normalized_metrics.views ?? 0),
    );
  }
  const values = [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-14)
    .map(([, value]) => value);
  if (!values.length) return Array.from({ length: 14 }, () => 2);
  const maximum = Math.max(...values, 1);
  return values.map((value) =>
    Math.max(2, Math.round((value / maximum) * 100)),
  );
}

function formatNumber(value: number): string {
  return Intl.NumberFormat("en-AU", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSigned(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

function dateRangeLabels(rangeDays: number) {
  const end = new Date();
  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - Math.round(rangeDays * ((4 - index) / 4)));
    return date.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
    });
  });
}

function MetricCard({
  icon,
  label,
  value,
  delta,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta: string;
  tone: string;
}) {
  return (
    <article className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span className="delta">
          <TrendingUp size={13} /> {delta}
        </span>
      </div>
    </article>
  );
}

function PlatformRow({
  platform,
  value,
  percent,
}: {
  platform: "instagram" | "tiktok" | "youtube";
  value: string;
  percent: number;
}) {
  return (
    <div className="platform-row">
      <div>
        <PlatformBadge platform={platform} />
        <strong>{value}</strong>
      </div>
      <div className="progress-track">
        <span
          className={`progress-${platform}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <small>{percent}% of views</small>
    </div>
  );
}
