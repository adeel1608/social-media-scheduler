import { AlertTriangle, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { PlatformBadge } from "../components/PlatformBadge";
import { StatusBadge } from "../components/StatusBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";
import { failedTargets } from "../lib/demoData";

type FailedItem = (typeof failedTargets)[number] & { mediaIds?: string[] };

export function FailedPage() {
  const { demoMode, session } = useAuth();
  const [retried, setRetried] = useState<string[]>([]);
  const [liveItems, setLiveItems] = useState<FailedItem[]>([]);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (demoMode || !session) return;
    void apiRequest<{
      data: Array<{
        id: string;
        platform: "instagram" | "tiktok" | "youtube";
        status: FailedItem["status"];
        scheduled_at_utc: string;
        remote_url?: string;
        last_error_message?: string;
        posts: {
          title: string;
          base_caption: string;
          post_media: Array<{ media_assets: { id: string } }>;
        };
      }>;
    }>("/api/queue?view=failed&limit=100", session)
      .then((result) =>
        setLiveItems(
          result.data.map((item) => ({
            id: item.id,
            title: item.posts.title,
            caption: item.posts.base_caption,
            platform: item.platform,
            status: item.status,
            scheduledAt: item.scheduled_at_utc,
            type: "Retained media",
            color:
              item.platform === "instagram"
                ? "coral"
                : item.platform === "tiktok"
                  ? "lilac"
                  : "blue",
            error:
              item.last_error_message ?? "The provider rejected this target.",
            ...(item.remote_url ? { remoteUrl: item.remote_url } : {}),
            mediaIds: item.posts.post_media.map(
              (media) => media.media_assets.id,
            ),
          })),
        ),
      )
      .catch((reason: unknown) =>
        setMessage(
          reason instanceof Error
            ? reason.message
            : "Failed targets could not be loaded.",
        ),
      );
  }, [demoMode, session]);
  const items: FailedItem[] = demoMode ? failedTargets : liveItems;

  async function retry(item: FailedItem) {
    if (demoMode || !session) {
      setRetried((value) => [...value, item.id]);
      return;
    }
    try {
      await apiRequest(`/api/targets/${item.id}/retry`, session, {
        method: "POST",
      });
      setRetried((value) => [...value, item.id]);
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Manual retry could not be queued.",
      );
    }
  }

  async function deleteMedia(item: FailedItem) {
    if (!session || !item.mediaIds?.length) return;
    if (
      !window.confirm("Permanently delete the retained source media from R2?")
    )
      return;
    try {
      for (const mediaId of item.mediaIds)
        await apiRequest(`/api/media/${mediaId}`, session, {
          method: "DELETE",
        });
      setMessage("Retained source media deleted. Post metadata was kept.");
      setLiveItems((current) => current.filter((row) => row.id !== item.id));
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Media could not be deleted.",
      );
    }
  }

  async function resolveAmbiguity(
    item: FailedItem,
    outcome: "published" | "failed",
  ) {
    if (demoMode || !session) {
      setMessage(
        "Resolution controls are disabled in local demonstration mode.",
      );
      return;
    }
    const warning =
      outcome === "published"
        ? "Confirm you found this exact content on the platform. Mark it published?"
        : "Confirm you checked the platform and the content does not exist. Mark it failed so it can be retried manually?";
    if (!window.confirm(warning)) return;
    try {
      await apiRequest(`/api/targets/${item.id}/resolve`, session, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      });
      if (outcome === "published")
        setLiveItems((current) => current.filter((row) => row.id !== item.id));
      else
        setLiveItems((current) =>
          current.map((row) =>
            row.id === item.id ? { ...row, status: "failed" } : row,
          ),
        );
      setMessage(
        outcome === "published"
          ? "Target marked published after owner verification."
          : "Target marked definitely failed. Manual retry is now available.",
      );
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Ambiguous result could not be resolved.",
      );
    }
  }
  return (
    <div>
      <section className="storage-warning">
        <AlertTriangle size={19} />
        <div>
          <strong>Failed source media is retained</strong>
          <p>
            It will not be deleted automatically. Resolve, retry, or delete it
            manually to avoid ongoing R2 storage use.
          </p>
        </div>
      </section>
      {message && <p className="form-message">{message}</p>}
      <div className="failed-list">
        {items.map((item) => (
          <article className="panel failed-card" key={item.id}>
            <div className={`failed-art ${item.color}`}>
              <span>{item.type.toUpperCase()}</span>
            </div>
            <div className="failed-content">
              <div className="failed-top">
                <PlatformBadge platform={item.platform} />
                <StatusBadge
                  status={retried.includes(item.id) ? "scheduled" : item.status}
                />
              </div>
              <h3>{item.title}</h3>
              <p className="error-message">
                <AlertTriangle size={15} />{" "}
                {retried.includes(item.id)
                  ? "Manual retry queued with a new idempotency key."
                  : item.error}
              </p>
              <div className="failed-meta">
                <span>
                  SCHEDULED{" "}
                  <strong>
                    {new Date(item.scheduledAt).toLocaleString("en-AU", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </strong>
                </span>
                <span>
                  MEDIA RETENTION <strong>Kept until resolved</strong>
                </span>
              </div>
            </div>
            <div className="failed-actions">
              {item.status === "needs_review" ? (
                <>
                  {item.remoteUrl ? (
                    <a
                      className="soft-button"
                      href={item.remoteUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={16} /> Check platform
                    </a>
                  ) : (
                    <span className="pending-text">Check platform first</span>
                  )}
                  <button
                    className="soft-button"
                    onClick={() => void resolveAmbiguity(item, "published")}
                  >
                    Mark found
                  </button>
                  <button
                    className="soft-button"
                    onClick={() => void resolveAmbiguity(item, "failed")}
                  >
                    Mark absent
                  </button>
                </>
              ) : (
                <button
                  className="primary-button"
                  onClick={() => void retry(item)}
                  disabled={retried.includes(item.id)}
                >
                  <RefreshCw size={16} />{" "}
                  {retried.includes(item.id) ? "Retry queued" : "Manual retry"}
                </button>
              )}
              {item.status !== "needs_review" && (
                <button
                  className="icon-button danger"
                  aria-label="Delete retained media"
                  onClick={() => void deleteMedia(item)}
                  disabled={demoMode}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </article>
        ))}
        {!items.length && !message && (
          <div className="empty-state panel">
            <h3>No failed targets</h3>
            <p>Definite failures and ambiguous results will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
