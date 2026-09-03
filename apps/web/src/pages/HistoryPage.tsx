import { ArrowUpRight, CalendarRange, Download } from "lucide-react";
import { useEffect, useState } from "react";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";
import { publishedTargets } from "../lib/demoData";

export function HistoryPage() {
  const { demoMode, session } = useAuth();
  const [liveItems, setLiveItems] = useState<typeof publishedTargets>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demoMode || !session) return;
    void apiRequest<{
      data: Array<{
        id: string;
        platform: "instagram" | "tiktok" | "youtube";
        status: "published";
        scheduled_at_utc: string;
        remote_url?: string;
        posts: { title: string; base_caption: string };
      }>;
    }>("/api/queue?view=published&limit=100", session)
      .then((result) =>
        setLiveItems(
          result.data.map((item) => ({
            id: item.id,
            title: item.posts.title,
            caption: item.posts.base_caption,
            platform: item.platform,
            status: item.status,
            scheduledAt: item.scheduled_at_utc,
            type: "Published content",
            color:
              item.platform === "instagram"
                ? "coral"
                : item.platform === "tiktok"
                  ? "lilac"
                  : "blue",
            ...(item.remote_url ? { remoteUrl: item.remote_url } : {}),
          })),
        ),
      )
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "History could not be loaded.",
        ),
      );
  }, [demoMode, session]);
  const items = demoMode ? publishedTargets : liveItems;
  return (
    <div>
      <div className="page-intro">
        <p>
          Permanent metadata and remote links remain here after source media
          becomes eligible for seven-day cleanup.
        </p>
        <div className="button-row">
          <button className="soft-button">
            <CalendarRange size={16} /> Last 90 days
          </button>
          <button className="soft-button">
            <Download size={16} /> Export
          </button>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <section className="panel history-list">
        {items.map((item) => (
          <article className="history-row" key={item.id}>
            <span className={`history-art ${item.color}`}>
              <span>
                POSTLINE
                <br />
                FIELD NOTE
              </span>
            </span>
            <div className="history-copy">
              <PlatformBadge platform={item.platform} />
              <h3>{item.title}</h3>
              <p>{item.caption}</p>
              <small>
                Published{" "}
                {new Date(item.scheduledAt).toLocaleDateString("en-AU", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}{" "}
                · {item.type}
              </small>
            </div>
            <div className="history-metrics">
              <span>
                <small>VIEWS</small>
                <strong>
                  {demoMode
                    ? item.platform === "instagram"
                      ? "18.4k"
                      : item.platform === "tiktok"
                        ? "12.8k"
                        : "9.7k"
                    : "Not provided"}
                </strong>
              </span>
              <span>
                <small>ENGAGEMENT</small>
                <strong>
                  {demoMode
                    ? item.platform === "instagram"
                      ? "8.7%"
                      : "5.9%"
                    : "Not provided"}
                </strong>
              </span>
            </div>
            {item.remoteUrl ? (
              <a
                className="icon-button"
                href={item.remoteUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Open on platform"
              >
                <ArrowUpRight size={17} />
              </a>
            ) : (
              <span />
            )}
          </article>
        ))}
        {!items.length && !error && (
          <div className="empty-state">
            <h3>No published posts yet</h3>
            <p>Completed platform targets will appear here independently.</p>
          </div>
        )}
      </section>
    </div>
  );
}
