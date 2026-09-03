export const platforms = ["instagram", "tiktok", "youtube"] as const;
export type Platform = (typeof platforms)[number];

export const targetStatuses = [
  "draft",
  "scheduled",
  "blocked_authorization",
  "queued",
  "publishing",
  "processing",
  "published",
  "failed",
  "needs_review",
  "cancelled",
] as const;
export type TargetStatus = (typeof targetStatuses)[number];

export type ContentType =
  | "instagram_feed_image"
  | "instagram_video"
  | "instagram_carousel"
  | "instagram_reel"
  | "instagram_story_image"
  | "instagram_story_video"
  | "tiktok_video"
  | "tiktok_photo"
  | "youtube_short"
  | "youtube_video";

export interface MediaDescriptor {
  id: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface InstagramMetadata {
  caption: string;
  altText?: string;
  contentType:
    | "feed_image"
    | "video"
    | "carousel"
    | "reel"
    | "story_image"
    | "story_video";
}

export interface TikTokMetadata {
  title: string;
  description?: string;
  contentType: "video" | "photo";
  privacyLevel:
    | "PUBLIC_TO_EVERYONE"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "SELF_ONLY";
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  commercialContent: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
  autoAddMusic?: boolean;
  creatorPrivacyOptions?: string[];
}

export interface YouTubeMetadata {
  title: string;
  description: string;
  contentType: "short" | "video";
  categoryId: string;
  tags: string[];
  privacyStatus: "public" | "unlisted" | "private";
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  thumbnailMediaId?: string;
}

export type PlatformMetadata =
  InstagramMetadata | TikTokMetadata | YouTubeMetadata;

export interface PostTarget {
  id: string;
  postId: string;
  platform: Platform;
  status: TargetStatus;
  scheduledAtUtc: string;
  metadata: PlatformMetadata;
  media: MediaDescriptor[];
  connectedAccountId?: string;
  idempotencyKey: string;
  leaseExpiresAt?: string;
  remoteContentId?: string;
  remoteUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  publishRequestSentAt?: string;
}

export interface PublishResult {
  outcome: "published" | "processing" | "failed" | "ambiguous";
  remoteContentId?: string;
  remoteUrl?: string;
  statusHandle?: string;
  uploadSession?: {
    url: string;
    nextByte: number;
    totalBytes: number;
    chunkSize: number;
  };
  sanitizedResponse: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface NormalizedMetric {
  name:
    | "views"
    | "reach"
    | "impressions"
    | "likes"
    | "comments"
    | "shares"
    | "saves"
    | "watch_time_minutes"
    | "average_view_duration_seconds"
    | "followers_delta";
  value: number | null;
  available: boolean;
  rawName?: string;
}
