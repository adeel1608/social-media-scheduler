import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  CloudUpload,
  FileVideo,
  Image,
  Info,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest, uploadDirect } from "../lib/api";

const platformOptions = ["instagram", "tiktok", "youtube"] as const;
type Platform = (typeof platformOptions)[number];

const platformLabels: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
};

interface UploadItem {
  localId: string;
  name: string;
  mimeType: string;
  progress: number;
  mediaId?: string;
}

interface ConnectedAccount {
  id: string;
  platform: Platform;
  connection_status: string;
  approval_state: string;
}

interface ComposerFields {
  instagramCaption: string;
  instagramAltText: string;
  instagramContentType:
    | "feed_image"
    | "video"
    | "carousel"
    | "reel"
    | "story_image"
    | "story_video";
  tiktokTitle: string;
  tiktokDescription: string;
  tiktokPrivacy:
    | "PUBLIC_TO_EVERYONE"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "SELF_ONLY";
  tiktokContentType: "video" | "photo";
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  commercialContent: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
  youtubeTitle: string;
  youtubeDescription: string;
  youtubeCategory: string;
  youtubeVisibility: "public" | "unlisted" | "private";
  youtubeMadeForKids: boolean;
  youtubeTags: string;
  youtubeSynthetic: boolean;
  youtubeContentType: "short" | "video";
  youtubeThumbnailMediaId: string;
}

const tomorrowInMelbourne = new Date(
  Date.now() + 86_400_000,
).toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

export function ComposerPage() {
  const { demoMode, session } = useAuth();
  const initialCaption =
    "A quiet reset for the days when the ideas feel far away. Save this for later ✦";
  const initialTitle = "Three ways to reset your creative energy";
  const [selected, setSelected] = useState<Platform[]>([
    "instagram",
    "youtube",
  ]);
  const [tab, setTab] = useState<Platform>("instagram");
  const [caption, setCaption] = useState(initialCaption);
  const [title, setTitle] = useState(initialTitle);
  const [date, setDate] = useState(tomorrowInMelbourne);
  const [time, setTime] = useState("09:30");
  const [uploads, setUploads] = useState<UploadItem[]>(
    demoMode
      ? [
          {
            localId: "demo-media",
            name: "creative-reset.mp4",
            mimeType: "video/mp4",
            progress: 100,
            mediaId: "11111111-1111-4111-8111-111111111111",
          },
        ]
      : [],
  );
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [fields, setFields] = useState<ComposerFields>({
    instagramCaption: initialCaption,
    instagramAltText: "",
    instagramContentType: "reel",
    tiktokTitle: initialTitle.slice(0, 150),
    tiktokDescription: initialCaption,
    tiktokPrivacy: "PUBLIC_TO_EVERYONE",
    tiktokContentType: "video",
    disableComment: false,
    disableDuet: false,
    disableStitch: false,
    commercialContent: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
    youtubeTitle: initialTitle.slice(0, 100),
    youtubeDescription: initialCaption,
    youtubeCategory: "22",
    youtubeVisibility: "public",
    youtubeMadeForKids: false,
    youtubeTags: "creative process, design, reset",
    youtubeSynthetic: false,
    youtubeContentType: "video",
    youtubeThumbnailMediaId: "",
  });

  useEffect(() => {
    if (demoMode || !session) return;
    void apiRequest<{ data: ConnectedAccount[] }>("/api/accounts", session)
      .then((result) => setAccounts(result.data))
      .catch((error: unknown) =>
        setMessage(
          error instanceof Error
            ? error.message
            : "Connected accounts could not be loaded.",
        ),
      );
  }, [demoMode, session]);

  const mediaIds = uploads.flatMap((item) =>
    item.mediaId ? [item.mediaId] : [],
  );
  const metadataValid = selected.every((platform) => {
    if (platform === "instagram")
      return fields.instagramCaption.length <= 2_200;
    if (platform === "tiktok")
      return (
        fields.tiktokTitle.trim().length > 0 &&
        fields.tiktokTitle.length <= 150 &&
        (!fields.commercialContent || fields.yourBrand || fields.brandedContent)
      );
    return (
      fields.youtubeTitle.trim().length > 0 &&
      fields.youtubeTitle.length <= 100 &&
      fields.youtubeDescription.length <= 5_000
    );
  });
  const thumbnailId = fields.youtubeThumbnailMediaId;
  const primaryUploads = uploads.filter(
    (item) => item.mediaId && item.mediaId !== thumbnailId,
  );
  const mediaValid = selected.every((platform) => {
    if (platform === "instagram") {
      if (fields.instagramContentType === "carousel")
        return primaryUploads.length >= 2 && primaryUploads.length <= 10;
      const expected = fields.instagramContentType.includes("image")
        ? "image/"
        : "video/";
      return (
        primaryUploads.length === 1 &&
        Boolean(primaryUploads[0]?.mimeType.startsWith(expected))
      );
    }
    if (platform === "tiktok") {
      const expected =
        fields.tiktokContentType === "photo" ? "image/" : "video/";
      return (
        primaryUploads.length >= 1 &&
        (fields.tiktokContentType === "photo" || primaryUploads.length === 1) &&
        primaryUploads.every((item) => item.mimeType.startsWith(expected))
      );
    }
    const videos = uploads.filter(
      (item) => item.mediaId && item.mimeType.startsWith("video/"),
    );
    const chosenThumbnail = uploads.find(
      (item) => item.mediaId === fields.youtubeThumbnailMediaId,
    );
    return (
      videos.length === 1 &&
      (!chosenThumbnail ||
        ["image/jpeg", "image/png"].includes(chosenThumbnail.mimeType))
    );
  });
  const scheduleReady = Boolean(
    selected.length > 0 &&
    title.trim() &&
    caption.trim() &&
    date &&
    time &&
    uploads.length > 0 &&
    uploads.every((item) => item.progress === 100 && item.mediaId) &&
    metadataValid &&
    mediaValid &&
    !submitting,
  );
  const previewPlatform = selected.includes(tab)
    ? tab
    : (selected[0] ?? "instagram");
  const previewLabel = useMemo(
    () => platformLabels[previewPlatform],
    [previewPlatform],
  );
  const previewCaption =
    previewPlatform === "instagram"
      ? fields.instagramCaption
      : previewPlatform === "tiktok"
        ? fields.tiktokDescription
        : fields.youtubeDescription;

  function setField<Key extends keyof ComposerFields>(
    key: Key,
    value: ComposerFields[Key],
  ) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function handleFile(file: File) {
    const localId = crypto.randomUUID();
    setMessage("");
    setUploads((current) => [
      ...current,
      { localId, name: file.name, mimeType: file.type, progress: 1 },
    ]);
    const update = (progress: number, mediaId?: string) =>
      setUploads((current) =>
        current.map((item) =>
          item.localId === localId
            ? { ...item, progress, ...(mediaId ? { mediaId } : {}) }
            : item,
        ),
      );
    if (demoMode || !session) {
      let progress = 1;
      const timer = window.setInterval(() => {
        progress += 11;
        update(
          Math.min(100, progress),
          progress >= 100 ? crypto.randomUUID() : undefined,
        );
        if (progress >= 100) window.clearInterval(timer);
      }, 90);
      return;
    }
    try {
      const uploaded = await uploadDirect(file, session, (progress) =>
        update(progress),
      );
      update(100, uploaded.mediaId);
    } catch (error) {
      update(0);
      setMessage(
        error instanceof Error ? error.message : `${file.name} upload failed.`,
      );
    }
  }

  function togglePlatform(platform: Platform) {
    setSelected((current) =>
      current.includes(platform)
        ? current.filter((value) => value !== platform)
        : [...current, platform],
    );
    setTab(platform);
  }

  function accountLabel(platform: Platform): string {
    if (demoMode)
      return platform === "instagram" ? "Connected" : "Approval pending";
    const account = accounts.find(
      (candidate) =>
        candidate.platform === platform &&
        candidate.connection_status === "connected",
    );
    if (!account) return "Not connected · target will be blocked";
    return account.approval_state === "pending"
      ? "Connected · approval pending"
      : "Connected";
  }

  async function schedulePost() {
    if (!scheduleReady) return;
    setSubmitting(true);
    setMessage("");
    const accountId = (platform: Platform) =>
      accounts.find(
        (account) =>
          account.platform === platform &&
          account.connection_status === "connected",
      )?.id;
    const targets = selected.map((platform) => {
      const connectedAccountId = accountId(platform);
      const primaryMediaIds = uploads
        .filter((item) => item.mediaId && item.mediaId !== thumbnailId)
        .map((item) => item.mediaId!);
      if (platform === "instagram")
        return {
          platform,
          ...(connectedAccountId ? { connectedAccountId } : {}),
          mediaIds: primaryMediaIds,
          metadata: {
            caption: fields.instagramCaption,
            ...(fields.instagramAltText
              ? { altText: fields.instagramAltText }
              : {}),
            contentType: fields.instagramContentType,
          },
        };
      if (platform === "tiktok")
        return {
          platform,
          ...(connectedAccountId ? { connectedAccountId } : {}),
          mediaIds: primaryMediaIds,
          metadata: {
            title: fields.tiktokTitle,
            description: fields.tiktokDescription,
            contentType: fields.tiktokContentType,
            privacyLevel: fields.tiktokPrivacy,
            disableComment: fields.disableComment,
            disableDuet: fields.disableDuet,
            disableStitch: fields.disableStitch,
            commercialContent: fields.commercialContent,
            yourBrand: fields.yourBrand,
            brandedContent: fields.brandedContent,
            aiGenerated: fields.aiGenerated,
          },
        };
      return {
        platform,
        ...(connectedAccountId ? { connectedAccountId } : {}),
        mediaIds: [
          ...uploads
            .filter(
              (item) => item.mediaId && item.mimeType.startsWith("video/"),
            )
            .map((item) => item.mediaId!),
          ...(thumbnailId ? [thumbnailId] : []),
        ],
        metadata: {
          title: fields.youtubeTitle,
          description: fields.youtubeDescription,
          contentType: fields.youtubeContentType,
          categoryId: fields.youtubeCategory,
          tags: fields.youtubeTags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          privacyStatus: fields.youtubeVisibility,
          madeForKids: fields.youtubeMadeForKids,
          containsSyntheticMedia: fields.youtubeSynthetic,
          ...(fields.youtubeThumbnailMediaId
            ? { thumbnailMediaId: fields.youtubeThumbnailMediaId }
            : {}),
        },
      };
    });
    if (demoMode || !session) {
      setMessage(
        "Demonstration only: nothing was stored or sent to a platform.",
      );
      setSubmitting(false);
      return;
    }
    try {
      await apiRequest("/api/posts", session, {
        method: "POST",
        body: JSON.stringify({
          title,
          baseCaption: caption,
          scheduledLocal: `${date}T${time}`,
          timezone: "Australia/Melbourne",
          mediaIds,
          targets,
        }),
      });
      setMessage(
        `Scheduled ${selected.length} independent platform target${selected.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The post was not scheduled.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="composer-layout">
      <section className="composer-form">
        <Step number="01" title="Choose platforms">
          Each platform publishes and reports independently.
        </Step>
        <div className="platform-selectors">
          {platformOptions.map((platform) => (
            <button
              key={platform}
              className={`platform-choice ${selected.includes(platform) ? "selected" : ""}`}
              onClick={() => togglePlatform(platform)}
            >
              <PlatformBadge platform={platform} compact />
              <span>
                {platformLabels[platform]}
                <small>{accountLabel(platform)}</small>
              </span>
              <i>{selected.includes(platform) && <Check size={14} />}</i>
            </button>
          ))}
        </div>

        <Step number="02" title="Add your media">
          Finished images and video only. Large files upload in resumable parts.
        </Step>
        <label
          className="upload-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            for (const file of event.dataTransfer.files) void handleFile(file);
          }}
        >
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
            onChange={(event) => {
              for (const file of event.target.files ?? [])
                void handleFile(file);
              event.currentTarget.value = "";
            }}
          />
          {!uploads.length ? (
            <>
              <span>
                <CloudUpload size={25} />
              </span>
              <strong>Drop finished media here</strong>
              <small>
                or click to browse · JPEG, PNG, WebP, MP4, MOV, WebM
              </small>
            </>
          ) : (
            <div className="upload-stack">
              {uploads.map((upload) => (
                <div className="upload-file" key={upload.localId}>
                  <span className="file-icon">
                    {upload.mimeType.startsWith("image/") ? (
                      <Image size={22} />
                    ) : (
                      <FileVideo size={22} />
                    )}
                  </span>
                  <div>
                    <strong>{upload.name}</strong>
                    <small>
                      {upload.progress === 100
                        ? "Ready · private R2 object"
                        : upload.progress === 0
                          ? "Upload failed"
                          : `Uploading ${upload.progress}%`}
                    </small>
                    <div className="upload-progress">
                      <span style={{ width: `${upload.progress}%` }} />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      setUploads((current) =>
                        current.filter(
                          (item) => item.localId !== upload.localId,
                        ),
                      );
                    }}
                    aria-label={`Remove ${upload.name}`}
                  >
                    <X size={17} />
                  </button>
                </div>
              ))}
              <small>
                Click or drop again to add carousel media or a thumbnail.
              </small>
            </div>
          )}
        </label>

        <Step number="03" title="Write the story">
          Start once, then tailor the details for each platform.
        </Step>
        <label className="field-label">
          Internal title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={180}
          />
        </label>
        <label className="field-label">
          Base caption
          <textarea
            rows={4}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            maxLength={5_000}
          />
          <small className="char-count">{caption.length} / 5,000</small>
        </label>

        <div className="metadata-tabs" role="tablist">
          {selected.map((platform) => (
            <button
              key={platform}
              role="tab"
              aria-selected={tab === platform}
              onClick={() => setTab(platform)}
            >
              <PlatformBadge platform={platform} compact />{" "}
              {platformLabels[platform]}
            </button>
          ))}
        </div>
        <PlatformFields
          platform={tab}
          fields={fields}
          setField={setField}
          uploads={uploads}
        />

        <Step number="04" title="Choose the moment">
          Australia/Melbourne time, stored safely in UTC.
        </Step>
        <div className="schedule-fields">
          <label>
            <CalendarDays size={17} />
            <span>
              Date
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </span>
          </label>
          <label>
            <Clock3 size={17} />
            <span>
              Time
              <input
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </span>
          </label>
          <div className="timezone-card">
            <strong>Melbourne</strong>
            <small>IANA timezone · DST-aware</small>
          </div>
        </div>
        <div className="dst-note">
          <Info size={16} />
          <span>
            Ambiguous or nonexistent daylight-saving times are rejected for you
            to correct.
          </span>
        </div>
      </section>

      <aside className="composer-preview">
        <div className="preview-heading">
          <div>
            <p className="eyebrow">LIVE PREVIEW</p>
            <h3>{previewLabel}</h3>
          </div>
          <div>
            <button className="icon-button" aria-label="Previous preview">
              <ChevronLeft size={16} />
            </button>
            <button className="icon-button" aria-label="Next preview">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <div className={`phone-preview preview-${previewPlatform}`}>
          <div className="phone-top">
            <span>9:41</span>
            <span>● ●</span>
          </div>
          <div className="phone-author">
            <span className="avatar small">AD</span>
            <div>
              <strong>your.account</strong>
              <small>Preview only</small>
            </div>
            <span>•••</span>
          </div>
          <div className="preview-media">
            <span className="preview-orbit one" />
            <span className="preview-orbit two" />
            <div>
              <small>FIELD NOTE · 014</small>
              <strong>
                reset
                <br />
                the signal
              </strong>
              <p>three ways back to your best ideas</p>
            </div>
          </div>
          <div className="preview-actions">
            ♡ &nbsp; ○ &nbsp; ⌁ <span>⌑</span>
          </div>
          <div className="preview-copy">
            <strong>your.account</strong> {previewCaption}
            <small>Final rendering is controlled by the platform</small>
          </div>
        </div>
        <div className="preview-status">
          <Sparkles size={15} />
          <span>
            Preview is approximate. The platform controls final rendering.
          </span>
        </div>
        <div className="schedule-summary">
          <div>
            <small>WILL PUBLISH</small>
            <strong>
              {new Date(`${date}T${time}:00`).toLocaleDateString("en-AU", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </strong>
            <span>
              {time} Melbourne · {selected.length} target
              {selected.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <button
          className="primary-button full schedule-button"
          disabled={!scheduleReady}
          onClick={() => void schedulePost()}
        >
          <Send size={17} /> {submitting ? "Scheduling…" : "Schedule"}{" "}
          {selected.length} target{selected.length === 1 ? "" : "s"}
        </button>
        {message && <p className="form-message">{message}</p>}
        {!scheduleReady && !message && (
          <p className="validation-copy">
            Complete valid platform fields and all media uploads to schedule.
          </p>
        )}
      </aside>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="step-header">
      <span>{number}</span>
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function PlatformFields({
  platform,
  fields,
  setField,
  uploads,
}: {
  platform: Platform;
  fields: ComposerFields;
  setField<Key extends keyof ComposerFields>(
    key: Key,
    value: ComposerFields[Key],
  ): void;
  uploads: UploadItem[];
}) {
  if (platform === "tiktok")
    return (
      <div className="metadata-panel">
        <div className="field-grid">
          <label className="field-label">
            TikTok title
            <input
              value={fields.tiktokTitle}
              maxLength={150}
              onChange={(event) => setField("tiktokTitle", event.target.value)}
            />
          </label>
          <label className="field-label">
            Content type
            <select
              value={fields.tiktokContentType}
              onChange={(event) =>
                setField(
                  "tiktokContentType",
                  event.target.value as ComposerFields["tiktokContentType"],
                )
              }
            >
              <option value="video">Video</option>
              <option value="photo">Photo or carousel</option>
            </select>
          </label>
          <label className="field-label">
            Privacy
            <select
              value={fields.tiktokPrivacy}
              onChange={(event) =>
                setField(
                  "tiktokPrivacy",
                  event.target.value as ComposerFields["tiktokPrivacy"],
                )
              }
            >
              <option>PUBLIC_TO_EVERYONE</option>
              <option>MUTUAL_FOLLOW_FRIENDS</option>
              <option>FOLLOWER_OF_CREATOR</option>
              <option>SELF_ONLY</option>
            </select>
          </label>
          <label className="field-label">
            AI content
            <select
              value={fields.aiGenerated ? "yes" : "no"}
              onChange={(event) =>
                setField("aiGenerated", event.target.value === "yes")
              }
            >
              <option value="no">No</option>
              <option value="yes">Yes — disclose</option>
            </select>
          </label>
        </div>
        <label className="field-label">
          TikTok description override
          <textarea
            rows={3}
            value={fields.tiktokDescription}
            maxLength={2_200}
            onChange={(event) =>
              setField("tiktokDescription", event.target.value)
            }
          />
        </label>
        <div className="toggle-grid">
          <Toggle
            label="Disable comments"
            value={fields.disableComment}
            onChange={(value) => setField("disableComment", value)}
          />
          <Toggle
            label="Disable duet"
            value={fields.disableDuet}
            onChange={(value) => setField("disableDuet", value)}
          />
          <Toggle
            label="Disable stitch"
            value={fields.disableStitch}
            onChange={(value) => setField("disableStitch", value)}
          />
          <Toggle
            label="Commercial content"
            value={fields.commercialContent}
            onChange={(value) => setField("commercialContent", value)}
          />
          <Toggle
            label="Your brand"
            value={fields.yourBrand}
            onChange={(value) => setField("yourBrand", value)}
          />
          <Toggle
            label="Branded content"
            value={fields.brandedContent}
            onChange={(value) => setField("brandedContent", value)}
          />
        </div>
        <p className="inline-warning">
          Public visibility stays blocked until TikTok approves and audits this
          app. The requested visibility is never silently downgraded.
        </p>
      </div>
    );
  if (platform === "youtube")
    return (
      <div className="metadata-panel">
        <div className="field-grid">
          <label className="field-label">
            YouTube title
            <input
              value={fields.youtubeTitle}
              maxLength={100}
              onChange={(event) => setField("youtubeTitle", event.target.value)}
            />
          </label>
          <label className="field-label">
            Type
            <select
              value={fields.youtubeContentType}
              onChange={(event) =>
                setField(
                  "youtubeContentType",
                  event.target.value as ComposerFields["youtubeContentType"],
                )
              }
            >
              <option value="video">Standard video</option>
              <option value="short">Short</option>
            </select>
          </label>
          <label className="field-label">
            Category
            <select
              value={fields.youtubeCategory}
              onChange={(event) =>
                setField("youtubeCategory", event.target.value)
              }
            >
              <option value="22">People &amp; Blogs</option>
              <option value="27">Education</option>
              <option value="26">Howto &amp; Style</option>
            </select>
          </label>
          <label className="field-label">
            Visibility
            <select
              value={fields.youtubeVisibility}
              onChange={(event) =>
                setField(
                  "youtubeVisibility",
                  event.target.value as ComposerFields["youtubeVisibility"],
                )
              }
            >
              <option>public</option>
              <option>unlisted</option>
              <option>private</option>
            </select>
          </label>
          <label className="field-label">
            Audience
            <select
              value={fields.youtubeMadeForKids ? "kids" : "not-kids"}
              onChange={(event) =>
                setField("youtubeMadeForKids", event.target.value === "kids")
              }
            >
              <option value="not-kids">Not made for kids</option>
              <option value="kids">Made for kids</option>
            </select>
          </label>
          <label className="field-label">
            Custom thumbnail
            <select
              value={fields.youtubeThumbnailMediaId}
              onChange={(event) =>
                setField("youtubeThumbnailMediaId", event.target.value)
              }
            >
              <option value="">Platform default</option>
              {uploads
                .filter(
                  (item) =>
                    item.mediaId &&
                    ["image/jpeg", "image/png"].includes(item.mimeType),
                )
                .map((item) => (
                  <option value={item.mediaId} key={item.localId}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="field-label">
          YouTube description override
          <textarea
            rows={3}
            value={fields.youtubeDescription}
            maxLength={5_000}
            onChange={(event) =>
              setField("youtubeDescription", event.target.value)
            }
          />
        </label>
        <label className="field-label">
          Tags
          <input
            value={fields.youtubeTags}
            onChange={(event) => setField("youtubeTags", event.target.value)}
          />
        </label>
        <div className="toggle-grid">
          <Toggle
            label="Contains realistic synthetic media"
            value={fields.youtubeSynthetic}
            onChange={(value) => setField("youtubeSynthetic", value)}
          />
        </div>
        <p className="inline-warning">
          Public visibility stays blocked until Google approves this API
          project’s upload audit.
        </p>
      </div>
    );
  return (
    <div className="metadata-panel">
      <label className="field-label">
        Instagram caption override
        <textarea
          rows={3}
          value={fields.instagramCaption}
          maxLength={2_200}
          onChange={(event) => setField("instagramCaption", event.target.value)}
        />
      </label>
      <label className="field-label">
        Image alt text
        <input
          value={fields.instagramAltText}
          placeholder="Describe the image for accessibility"
          maxLength={1_000}
          onChange={(event) => setField("instagramAltText", event.target.value)}
        />
      </label>
      <div className="field-grid">
        <label className="field-label">
          Content type
          <select
            value={fields.instagramContentType}
            onChange={(event) =>
              setField(
                "instagramContentType",
                event.target.value as ComposerFields["instagramContentType"],
              )
            }
          >
            <option value="feed_image">Feed image</option>
            <option value="video">Video</option>
            <option value="carousel">Carousel</option>
            <option value="reel">Reel</option>
            <option value="story_image">Story image</option>
            <option value="story_video">Story video</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
      />{" "}
      {label}
    </label>
  );
}
