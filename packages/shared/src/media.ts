import type { MediaDescriptor, Platform } from "./types";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024 * 1024;
const allowedImages = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedVideos = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/octet-stream",
]);

export interface MediaValidationIssue {
  field: string;
  message: string;
}

export function validateMedia(
  media: Pick<MediaDescriptor, "mimeType" | "sizeBytes" | "width" | "height">,
  platform?: Platform,
): MediaValidationIssue[] {
  const issues: MediaValidationIssue[] = [];
  const isImage = media.mimeType.startsWith("image/");
  const isVideo =
    media.mimeType.startsWith("video/") ||
    media.mimeType === "application/octet-stream";
  if (!isImage && !isVideo)
    issues.push({
      field: "mimeType",
      message: "Only images and videos are accepted.",
    });
  if (isImage && !allowedImages.has(media.mimeType)) {
    issues.push({
      field: "mimeType",
      message: "Use JPEG, PNG, or WebP images.",
    });
  }
  if (isVideo && !allowedVideos.has(media.mimeType)) {
    issues.push({ field: "mimeType", message: "Use MP4, MOV, or WebM video." });
  }
  if (isImage && media.sizeBytes > MAX_IMAGE_BYTES) {
    issues.push({
      field: "sizeBytes",
      message: "Image exceeds the scheduler's 30 MB safety limit.",
    });
  }
  if (isVideo && media.sizeBytes > MAX_VIDEO_BYTES) {
    issues.push({
      field: "sizeBytes",
      message: "Video exceeds YouTube's documented 256 GB maximum.",
    });
  }
  if (platform === "instagram" && media.mimeType === "image/webp") {
    issues.push({
      field: "mimeType",
      message: "Instagram publishing requires JPEG for image containers.",
    });
  }
  if (media.width && media.height && media.width / media.height > 20) {
    issues.push({
      field: "dimensions",
      message: "Media aspect ratio is unusually wide.",
    });
  }
  return issues;
}
