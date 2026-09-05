import {
  normalizeAnalytics,
  tikTokMetadataSchema,
  validateMedia,
  type TikTokMetadata,
} from "@scheduler/shared";

import {
  genericNormalizeError,
  jsonRequest,
  trustedUploadSessionUrl,
} from "./http";
import type {
  AccountProfile,
  AnalyticsRequest,
  AuthorizationRequest,
  Fetch,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformError,
  PublishInput,
  TokenSet,
  ValidationResult,
} from "./types";

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  contentPostingAudited: boolean;
}

export const TIKTOK_REQUIRED_SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "user.info.stats",
  "video.list",
  "video.publish",
] as const;

interface TikTokTokenResponse {
  access_token: string;
  refresh_token: string;
  open_id: string;
  expires_in: number;
  refresh_expires_in: number;
  scope: string;
}

class TikTokProtocolError extends Error {
  readonly ambiguous = false;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TikTokProtocolError";
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseTokenResponse(value: unknown): TikTokTokenResponse {
  const data = objectValue(value);
  if (
    !data ||
    typeof data.access_token !== "string" ||
    data.access_token.length === 0 ||
    typeof data.refresh_token !== "string" ||
    data.refresh_token.length === 0 ||
    typeof data.open_id !== "string" ||
    data.open_id.length === 0 ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    typeof data.refresh_expires_in !== "number" ||
    !Number.isFinite(data.refresh_expires_in) ||
    data.refresh_expires_in <= 0 ||
    typeof data.scope !== "string"
  ) {
    throw new TikTokProtocolError(
      "invalid_tiktok_oauth_response",
      "TikTok returned an invalid OAuth response.",
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id,
    expires_in: data.expires_in,
    refresh_expires_in: data.refresh_expires_in,
    scope: data.scope,
  };
}

function parseGrantedScopes(value: string): string[] {
  const scopes = [
    ...new Set(value.split(",").map((scope) => scope.trim())),
  ].filter(Boolean);
  const missing = TIKTOK_REQUIRED_SCOPES.filter(
    (required) => !scopes.includes(required),
  );
  if (missing.length > 0) {
    throw new TikTokProtocolError(
      "missing_tiktok_scopes",
      "TikTok did not grant every scope required by this installation.",
    );
  }
  return scopes;
}

function tokenSet(data: TikTokTokenResponse): TokenSet {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: data.open_id,
    expiresAt: new Date(Date.now() + data.expires_in * 1_000).toISOString(),
    scopes: parseGrantedScopes(data.scope),
    raw: {
      open_id: data.open_id,
      refreshTokenExpiresAt: new Date(
        Date.now() + data.refresh_expires_in * 1_000,
      ).toISOString(),
    },
  };
}

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok" as const;

  constructor(
    private readonly config: TikTokConfig,
    private readonly fetcher: Fetch = fetch,
  ) {}

  getAuthorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({
      client_key: this.config.clientKey,
      redirect_uri: request.redirectUri,
      response_type: "code",
      scope:
        "user.info.basic,user.info.profile,user.info.stats,video.list,video.publish",
      state: request.state,
      ...(request.codeChallenge
        ? {
            code_challenge: request.codeChallenge,
            code_challenge_method: "S256",
          }
        : {}),
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    verifier?: string,
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_key: this.config.clientKey,
      client_secret: this.config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      ...(verifier ? { code_verifier: verifier } : {}),
    });
    const response = await jsonRequest<unknown>(
      this.fetcher,
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    return tokenSet(parseTokenResponse(response));
  }

  async refreshAccessToken(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken)
      throw new Error("TikTok refresh token is missing");
    const response = await jsonRequest<unknown>(
      this.fetcher,
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: this.config.clientKey,
          client_secret: this.config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }),
      },
    );
    return tokenSet(parseTokenResponse(response));
  }

  async disconnect(accessToken: string): Promise<void> {
    try {
      const response = await jsonRequest<unknown>(
        this.fetcher,
        "https://open.tiktokapis.com/v2/oauth/revoke/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: this.config.clientKey,
            client_secret: this.config.clientSecret,
            token: accessToken,
          }),
        },
      );
      const data = objectValue(response);
      if (!data || Object.keys(data).length !== 0) {
        throw new TikTokProtocolError(
          "invalid_tiktok_revoke_response",
          "TikTok returned an invalid revocation response.",
        );
      }
    } catch {
      throw new TikTokProtocolError(
        "tiktok_revoke_failed",
        "TikTok token revocation failed.",
      );
    }
  }

  async getAccountProfile(accessToken: string): Promise<AccountProfile> {
    const response = await jsonRequest<unknown>(
      this.fetcher,
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const data = objectValue(response);
    const nestedData = objectValue(data?.data);
    const user = objectValue(nestedData?.user);
    if (
      !user ||
      typeof user.open_id !== "string" ||
      user.open_id.length === 0 ||
      (typeof user.username !== "string" &&
        typeof user.display_name !== "string")
    ) {
      throw new TikTokProtocolError(
        "invalid_tiktok_profile_response",
        "TikTok returned an invalid account profile.",
      );
    }
    return {
      id: user.open_id,
      username:
        typeof user.username === "string"
          ? user.username
          : (user.display_name as string),
      ...(typeof user.display_name === "string"
        ? { displayName: user.display_name }
        : {}),
      ...(typeof user.avatar_url === "string"
        ? { avatarUrl: user.avatar_url }
        : {}),
    };
  }

  getCapabilities(): PlatformCapabilities {
    return {
      platform: "tiktok",
      contentTypes: ["video", "photo"],
      supportsDirectPublicPublishing: this.config.contentPostingAudited,
      requiresAppReview: true,
      supportsStatusPolling: true,
      supportsChunkedUpload: true,
      analyticsMetrics: [
        "view_count",
        "like_count",
        "comment_count",
        "share_count",
        "follower_count",
      ],
      limitations: [
        "Public direct posting is blocked until TikTok completes the Content Posting API audit.",
        "Unaudited clients are restricted by TikTok to private visibility; this app will not silently downgrade.",
        "Photo posts require URLs under a verified domain or URL prefix.",
        "Creator info must be queried immediately before publishing and its privacy options respected.",
      ],
    };
  }

  validatePost(
    metadata: unknown,
    media: PublishInput["media"],
  ): ValidationResult {
    const parsed = tikTokMetadataSchema.safeParse(metadata);
    const errors = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));
    for (const item of media) errors.push(...validateMedia(item, "tiktok"));
    for (const item of media) {
      if (
        item.mimeType.startsWith("video/") &&
        item.sizeBytes > 4 * 1024 * 1024 * 1024
      ) {
        errors.push({
          field: "media",
          message: "TikTok videos may not exceed 4 GB.",
        });
      }
      if (
        item.mimeType.startsWith("video/") &&
        (!item.durationSeconds || !Number.isFinite(item.durationSeconds))
      ) {
        errors.push({
          field: "media",
          message:
            "TikTok video duration is required so creator limits can be enforced.",
        });
      }
      if (
        item.mimeType.startsWith("image/") &&
        item.sizeBytes > 20 * 1024 * 1024
      ) {
        errors.push({
          field: "media",
          message: "TikTok images may not exceed 20 MB each.",
        });
      }
      if (
        item.mimeType.startsWith("image/") &&
        ((item.width ?? 0) > 1080 || (item.height ?? 0) > 1080)
      ) {
        errors.push({
          field: "media",
          message: "TikTok photo posts support images up to 1080p.",
        });
      }
    }
    if (
      !this.config.contentPostingAudited &&
      parsed.success &&
      parsed.data.privacyLevel === "PUBLIC_TO_EVERYONE"
    ) {
      errors.push({
        field: "privacyLevel",
        message:
          "Public TikTok posting is blocked until the app audit is approved.",
      });
    }
    if (
      parsed.success &&
      parsed.data.contentType === "video" &&
      (media.length !== 1 || !media[0]?.mimeType.startsWith("video/"))
    ) {
      errors.push({
        field: "media",
        message: "TikTok video posts require exactly one video.",
      });
    }
    if (
      parsed.success &&
      parsed.data.contentType === "photo" &&
      (media.length < 1 ||
        media.length > 35 ||
        media.some((item) => !item.mimeType.startsWith("image/")))
    ) {
      errors.push({
        field: "media",
        message: "TikTok photo posts require 1–35 images.",
      });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  private async creatorInfo(accessToken: string) {
    return jsonRequest<{
      data: {
        privacy_level_options: string[];
        max_video_post_duration_sec: number;
        comment_disabled: boolean;
        duet_disabled: boolean;
        stitch_disabled: boolean;
      };
    }>(
      this.fetcher,
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
  }

  async publish(input: PublishInput) {
    const metadata = input.metadata as TikTokMetadata;
    if (
      metadata.privacyLevel === "PUBLIC_TO_EVERYONE" &&
      !this.config.contentPostingAudited
    ) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: { blocked: "tiktok_audit_pending" },
        error: {
          code: "audit_required",
          message: "TikTok public posting requires an approved audit.",
          retryable: false,
        },
      };
    }
    const creator = await this.creatorInfo(input.accessToken);
    if (!creator.data.privacy_level_options.includes(metadata.privacyLevel)) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: {
          availablePrivacyLevels: creator.data.privacy_level_options,
        },
        error: {
          code: "privacy_unavailable",
          message:
            "The creator account does not currently allow that privacy level.",
          retryable: false,
        },
      };
    }
    const creatorRestriction = (field: string, message: string) => ({
      outcome: "failed" as const,
      sanitizedResponse: { blocked: "creator_restriction", field },
      error: {
        code: "creator_restriction",
        message,
        retryable: false,
      },
    });
    if (creator.data.comment_disabled && !metadata.disableComment) {
      return creatorRestriction(
        "disableComment",
        "The creator account currently requires comments to be disabled.",
      );
    }
    if (metadata.contentType === "video") {
      if (creator.data.duet_disabled && !metadata.disableDuet) {
        return creatorRestriction(
          "disableDuet",
          "The creator account currently requires duets to be disabled.",
        );
      }
      if (creator.data.stitch_disabled && !metadata.disableStitch) {
        return creatorRestriction(
          "disableStitch",
          "The creator account currently requires stitches to be disabled.",
        );
      }
      const duration = input.media[0]?.durationSeconds;
      if (
        !Number.isFinite(creator.data.max_video_post_duration_sec) ||
        creator.data.max_video_post_duration_sec <= 0 ||
        !duration ||
        duration > creator.data.max_video_post_duration_sec
      ) {
        return creatorRestriction(
          "media",
          "The video duration exceeds, or cannot be checked against, the creator account's current limit.",
        );
      }
    }
    const headers = {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    };
    if (metadata.contentType === "photo") {
      const result = await jsonRequest<{
        data: { publish_id: string };
        error: { code: string };
      }>(
        this.fetcher,
        "https://open.tiktokapis.com/v2/post/publish/content/init/",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            post_info: {
              title: metadata.title,
              description: metadata.description,
              privacy_level: metadata.privacyLevel,
              disable_comment: metadata.disableComment,
              auto_add_music: metadata.autoAddMusic ?? false,
              brand_content_toggle: metadata.brandedContent,
              brand_organic_toggle: metadata.yourBrand,
            },
            source_info: {
              source: "PULL_FROM_URL",
              photo_images: input.deliveryUrls,
              photo_cover_index: 0,
            },
            post_mode: "DIRECT_POST",
            media_type: "PHOTO",
            is_aigc: metadata.aiGenerated,
          }),
        },
      );
      return {
        outcome: "processing" as const,
        statusHandle: result.data.publish_id,
        sanitizedResponse: { publishId: result.data.publish_id },
      };
    }
    const source = input.media[0]!;
    const chunkSize = Math.min(source.sizeBytes, 10_000_000);
    const totalChunks = Math.ceil(source.sizeBytes / chunkSize);
    const result = await jsonRequest<{
      data: { publish_id: string; upload_url: string };
    }>(
      this.fetcher,
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          post_info: {
            title: metadata.title,
            privacy_level: metadata.privacyLevel,
            disable_duet: metadata.disableDuet,
            disable_comment: metadata.disableComment,
            disable_stitch: metadata.disableStitch,
            brand_content_toggle: metadata.brandedContent,
            brand_organic_toggle: metadata.yourBrand,
            is_aigc: metadata.aiGenerated,
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: source.sizeBytes,
            chunk_size: chunkSize,
            total_chunk_count: totalChunks,
          },
        }),
      },
    );
    const uploadUrl = trustedUploadSessionUrl("tiktok", result.data.upload_url);
    return {
      outcome: "processing" as const,
      statusHandle: result.data.publish_id,
      uploadSession: {
        url: uploadUrl,
        nextByte: 0,
        totalBytes: source.sizeBytes,
        chunkSize,
      },
      sanitizedResponse: {
        publishId: result.data.publish_id,
        uploadSessionCreated: true,
        totalBytes: source.sizeBytes,
      },
    };
  }

  async getPublishStatus(accessToken: string, statusHandle: string) {
    const result = await jsonRequest<{
      data: {
        status: string;
        publicaly_available_post_id?: string[];
        fail_reason?: string;
      };
    }>(
      this.fetcher,
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ publish_id: statusHandle }),
      },
    );
    if (result.data.status === "PUBLISH_COMPLETE") {
      const id = result.data.publicaly_available_post_id?.[0];
      return {
        outcome: "published" as const,
        ...(id ? { remoteContentId: id } : {}),
        sanitizedResponse: result.data,
      };
    }
    if (result.data.status === "FAILED") {
      return {
        outcome: "failed" as const,
        sanitizedResponse: result.data,
        error: {
          code: "publish_failed",
          message: result.data.fail_reason ?? "TikTok processing failed.",
          retryable: false,
        },
      };
    }
    return {
      outcome: "processing" as const,
      statusHandle,
      sanitizedResponse: result.data,
    };
  }

  async fetchAnalytics(request: AnalyticsRequest) {
    const fields = "id,view_count,like_count,comment_count,share_count";
    const endpoint = request.remoteContentId ? "query" : "list";
    const result = await jsonRequest<{
      data: { videos: Array<Record<string, any>> };
    }>(
      this.fetcher,
      `https://open.tiktokapis.com/v2/video/${endpoint}/?fields=${fields}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          request.remoteContentId
            ? { filters: { video_ids: [request.remoteContentId] } }
            : { max_count: 20 },
        ),
      },
    );
    return normalizeAnalytics("tiktok", result.data.videos[0] ?? {});
  }

  normalizeError(error: unknown): PlatformError {
    return genericNormalizeError(error);
  }
}
