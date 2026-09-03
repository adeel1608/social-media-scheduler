import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

interface Snapshot {
  id: string;
  platform: "instagram" | "tiktok" | "youtube";
  captured_at: string;
  normalized_metrics: Record<string, number | null>;
  raw_metrics: Record<string, number | null>;
  unavailable_metrics: string[];
  post_targets: {
    remote_url?: string;
    posts: { title: string };
  };
}

const metricLabels: Record<string, string> = {
  views: "Views",
  reach: "Reach",
  impressions: "Impressions",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  watch_time_minutes: "Watch time (minutes)",
  average_view_duration_seconds: "Average view duration (seconds)",
  followers_delta: "Audience change",
};

export function PostAnalyticsPage() {
  const { targetId = "" } = useParams();
  const { demoMode, session } = useAuth();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (demoMode || !session) return;
    void apiRequest<{ data: Snapshot[] }>(
      `/api/analytics/${encodeURIComponent(targetId)}`,
      session,
    )
      .then((result) => setSnapshots(result.data))
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Post analytics could not be loaded.",
        ),
      );
  }, [demoMode, session, targetId]);

  const current = demoMode
    ? ({
        id: "demo",
        platform: "instagram",
        captured_at: new Date().toISOString(),
        normalized_metrics: {
          views: 18_400,
          reach: 15_920,
          impressions: 21_100,
          likes: 1_240,
          comments: 148,
          shares: 96,
          saves: 112,
          watch_time_minutes: null,
          average_view_duration_seconds: null,
          followers_delta: 74,
        },
        raw_metrics: { views: 18_400, reach: 15_920 },
        unavailable_metrics: [
          "watch_time_minutes",
          "average_view_duration_seconds",
        ],
        post_targets: { posts: { title: "Designing a calmer Monday" } },
      } satisfies Snapshot)
    : snapshots[0];
  const timeline = useMemo(
    () => [...snapshots].reverse().slice(-20),
    [snapshots],
  );

  return (
    <div>
      <div className="page-intro">
        <Link className="soft-button" to="/analytics">
          <ArrowLeft size={16} /> Back to overview
        </Link>
        {current?.post_targets.remote_url && (
          <a
            className="soft-button"
            href={current.post_targets.remote_url}
            target="_blank"
            rel="noreferrer"
          >
            Open on platform <ExternalLink size={15} />
          </a>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
      {current ? (
        <>
          <section className="panel post-analytics-heading">
            <PlatformBadge platform={current.platform} />
            <div>
              <h2>{current.post_targets.posts.title}</h2>
              <p>
                Latest official-API snapshot:{" "}
                {new Date(current.captured_at).toLocaleString("en-AU")}
              </p>
            </div>
          </section>
          <section className="analytics-detail-grid">
            {Object.entries(metricLabels).map(([name, label]) => {
              const value = current.normalized_metrics[name];
              const unavailable =
                current.unavailable_metrics.includes(name) || value === null;
              return (
                <article className="metric-card" key={name}>
                  <div>
                    <p>{label}</p>
                    <strong>
                      {unavailable
                        ? "Not provided"
                        : Intl.NumberFormat("en-AU", {
                            maximumFractionDigits: 2,
                          }).format(value ?? 0)}
                    </strong>
                    <span className="metric-availability">
                      {unavailable
                        ? `Unavailable from ${current.platform} for this content`
                        : "Available"}
                    </span>
                  </div>
                </article>
              );
            })}
          </section>
          <section className="panel snapshot-history">
            <h3>Historical snapshots</h3>
            <p>
              {timeline.length
                ? `${timeline.length} stored capture${timeline.length === 1 ? "" : "s"}. Raw provider metric names are retained alongside these normalized fields.`
                : "No historical captures yet."}
            </p>
            <div
              className="snapshot-bars"
              aria-label="Historical view snapshots"
            >
              {timeline.map((snapshot) => (
                <span
                  key={snapshot.id}
                  title={`${snapshot.captured_at}: ${snapshot.normalized_metrics.views ?? "unavailable"} views`}
                  style={{
                    height: `${Math.max(4, Math.min(100, (snapshot.normalized_metrics.views ?? 0) / 100))}%`,
                  }}
                />
              ))}
            </div>
          </section>
          <p className="data-note">
            Engagement rate = (likes + comments + shares + saves) ÷ views × 100.
            Missing metrics remain unavailable and are not treated as equivalent
            to zero.
          </p>
        </>
      ) : (
        <div className="empty-state panel">
          <h3>No snapshots for this post</h3>
          <p>Run analytics sync after the target has published.</p>
        </div>
      )}
    </div>
  );
}
