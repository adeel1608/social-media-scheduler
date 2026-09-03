import {
  ChevronDown,
  Filter,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useEffect } from "react";

import { PlatformBadge } from "../components/PlatformBadge";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";
import { demoQueue } from "../lib/demoData";

const ROW_HEIGHT = 84;
const VIEW_HEIGHT = 584;

export function QueuePage() {
  const { demoMode, session } = useAuth();
  const [scrollTop, setScrollTop] = useState(0);
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [liveRows, setLiveRows] = useState<typeof demoQueue>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadPage(cursor?: string) {
    if (demoMode || !session) return;
    setLoading(true);
    setError("");
    const parameters = new URLSearchParams({ view: "queue", limit: "100" });
    if (platform !== "all") parameters.set("platform", platform);
    if (cursor) parameters.set("cursor", cursor);
    try {
      const result = await apiRequest<{
        data: Array<{
          id: string;
          platform: "instagram" | "tiktok" | "youtube";
          status: (typeof demoQueue)[number]["status"];
          scheduled_at_utc: string;
          remote_url?: string;
          last_error_message?: string;
          posts: { title: string; base_caption: string };
        }>;
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/api/queue?${parameters}`, session);
      const normalized = result.data.map((item) => ({
        id: item.id,
        title: item.posts.title,
        caption: item.posts.base_caption,
        platform: item.platform,
        status: item.status,
        scheduledAt: item.scheduled_at_utc,
        type: "Scheduled content",
        color:
          item.platform === "instagram"
            ? "coral"
            : item.platform === "tiktok"
              ? "lilac"
              : "blue",
        ...(item.remote_url ? { remoteUrl: item.remote_url } : {}),
        ...(item.last_error_message ? { error: item.last_error_message } : {}),
      }));
      setLiveRows((current) =>
        cursor ? [...current, ...normalized] : normalized,
      );
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Queue could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLiveRows([]);
    setScrollTop(0);
    void loadPage();
  }, [demoMode, session, platform]);

  const sourceRows = demoMode ? demoQueue : liveRows;
  const rows = useMemo(
    () =>
      sourceRows.filter(
        (item) =>
          (demoMode
            ? platform === "all" || item.platform === platform
            : true) && item.title.toLowerCase().includes(query.toLowerCase()),
      ),
    [demoMode, platform, query, sourceRows],
  );
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const visibleCount = Math.ceil(VIEW_HEIGHT / ROW_HEIGHT) + 7;
  const visible = rows.slice(start, start + visibleCount);

  return (
    <div className="queue-page">
      <section className="queue-summary">
        <div>
          <strong>{rows.length.toLocaleString()}</strong>
          <span>targets in queue</span>
        </div>
        <div>
          <strong>
            {
              rows.filter(
                (item) =>
                  new Date(item.scheduledAt).toDateString() ===
                  new Date().toDateString(),
              ).length
            }
          </strong>
          <span>publishing today</span>
        </div>
        <div>
          <strong>
            {
              rows.filter((item) => item.status === "blocked_authorization")
                .length
            }
          </strong>
          <span>approval blocked</span>
        </div>
        <p>
          No app limit. Infrastructure storage and official API quotas still
          apply.
        </p>
      </section>
      <section className="panel queue-panel">
        <div className="queue-toolbar">
          <div className="search-box">
            <Search size={17} />
            <input
              aria-label="Search queue"
              placeholder="Search queue…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="button-row">
            <label className="select-button">
              <Filter size={16} />
              <select
                aria-label="Filter by platform"
                value={platform}
                onChange={(event) => setPlatform(event.target.value)}
              >
                <option value="all">All platforms</option>
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
                <option value="youtube">YouTube</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <button className="soft-button">
              <SlidersHorizontal size={16} /> More filters
            </button>
          </div>
        </div>
        <div className="queue-head">
          <span>CONTENT</span>
          <span>PLATFORM</span>
          <span>SCHEDULED</span>
          <span>STATUS</span>
          <span />
        </div>
        {error && <p className="form-error">{error}</p>}
        {rows.length ? (
          <div
            className="virtual-list"
            style={{ height: VIEW_HEIGHT }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            data-testid="virtual-queue"
          >
            <div
              style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}
            >
              <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
                {visible.map((item) => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    canCancel={
                      !demoMode &&
                      ["draft", "scheduled", "blocked_authorization"].includes(
                        item.status,
                      )
                    }
                    onCancel={async () => {
                      if (!session) return;
                      if (
                        !window.confirm(
                          `Cancel ${item.title} for ${item.platform}?`,
                        )
                      )
                        return;
                      try {
                        await apiRequest(
                          `/api/targets/${item.id}/cancel`,
                          session,
                          {
                            method: "PATCH",
                          },
                        );
                        setLiveRows((current) =>
                          current.filter((row) => row.id !== item.id),
                        );
                      } catch (reason) {
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : "Target could not be cancelled.",
                        );
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <Search size={24} />
            <h3>No queue items match</h3>
            <p>Try clearing a filter or searching a different phrase.</p>
          </div>
        )}
        <div className="queue-foot">
          <span>
            Showing a virtualized window of {rows.length.toLocaleString()}{" "}
            records
          </span>
          <span>
            {demoMode
              ? "Scroll through the complete demonstration set"
              : hasMore
                ? "Load the next server page when needed"
                : "All matching records loaded"}
          </span>
          {!demoMode && hasMore && (
            <button
              className="soft-button"
              disabled={loading}
              onClick={() => void loadPage(nextCursor ?? undefined)}
            >
              {loading ? "Loading…" : "Load next 100"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function QueueRow({
  item,
  canCancel,
  onCancel,
}: {
  item: (typeof demoQueue)[number];
  canCancel: boolean;
  onCancel(): Promise<void>;
}) {
  const date = new Date(item.scheduledAt);
  return (
    <div className="queue-row" style={{ height: ROW_HEIGHT }}>
      <div className="content-cell">
        <span className={`thumb ${item.color}`} />
        <div>
          <strong>{item.title}</strong>
          <small>{item.type}</small>
        </div>
      </div>
      <PlatformBadge platform={item.platform} />
      <div className="date-cell">
        <strong>
          {date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
        </strong>
        <small>
          {date.toLocaleTimeString("en-AU", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "Australia/Melbourne",
          })}{" "}
          AEST
        </small>
      </div>
      <StatusBadge status={item.status} />
      <button
        className="icon-button"
        aria-label={
          canCancel ? `Cancel ${item.title}` : `Options for ${item.title}`
        }
        onClick={() => canCancel && void onCancel()}
      >
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
}
