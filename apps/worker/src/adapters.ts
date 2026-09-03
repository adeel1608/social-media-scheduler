import {
  InstagramAdapter,
  TikTokAdapter,
  YouTubeAdapter,
  type PlatformAdapter,
} from "@scheduler/platforms";
import type { Platform } from "@scheduler/shared";

import type { Env } from "./env";

export function adapterFor(platform: Platform, env: Env): PlatformAdapter {
  switch (platform) {
    case "instagram":
      return new InstagramAdapter({
        appId: env.META_APP_ID,
        appSecret: env.META_APP_SECRET,
        graphVersion: env.META_GRAPH_VERSION,
        reviewApproved: env.META_APP_REVIEW_APPROVED === "true",
      });
    case "tiktok":
      return new TikTokAdapter({
        clientKey: env.TIKTOK_CLIENT_KEY,
        clientSecret: env.TIKTOK_CLIENT_SECRET,
        contentPostingAudited: env.TIKTOK_CONTENT_POSTING_AUDITED === "true",
      });
    case "youtube":
      return new YouTubeAdapter({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        apiAuditApproved: env.YOUTUBE_API_AUDIT_APPROVED === "true",
      });
  }
}

export function redirectUriFor(platform: Platform, env: Env): string {
  return {
    instagram: env.META_REDIRECT_URI,
    tiktok: env.TIKTOK_REDIRECT_URI,
    youtube: env.GOOGLE_REDIRECT_URI,
  }[platform];
}
