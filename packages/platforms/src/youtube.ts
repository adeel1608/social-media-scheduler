import {
  normalizeAnalytics,
  validateMedia,
  youTubeMetadataSchema,
  type YouTubeMetadata,
} from "@scheduler/shared";

import {
  genericNormalizeError,
  jsonRequest,
  providerHttpError,
  providerRequest,
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

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  apiAuditApproved: boolean;
}

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = "youtube" as const;

  constructor(
    private readonly config: YouTubeConfig,
    private readonly fetcher: Fetch = fetch,
  ) {}

  getAuthorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
      ].join(" "),
      state: request.state,
      ...(request.codeChallenge
        ? {
            code_challenge: request.codeChallenge,
            code_challenge_method: "S256",
          }
        : {}),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    verifier?: string,
  ): Promise<TokenSet> {
    const data = await jsonRequest<Record<string, any>>(
      this.fetcher,
      "https://oauth2.googleapis.com/token",
      {
        operation: "idempotent",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          ...(verifier ? { code_verifier: verifier } : {}),
        }),
      },
    );
    return {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: new Date(Date.now() + data.expires_in * 1_000).toISOString(),
      scopes: String(data.scope ?? "")
        .split(" ")
        .filter(Boolean),
      raw: { token_type: data.token_type },
    };
  }

  async refreshAccessToken(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken)
      throw new Error("Google refresh token is missing");
    const data = await jsonRequest<Record<string, any>>(
      this.fetcher,
      "https://oauth2.googleapis.com/token",
      {
        operation: "idempotent",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: tokens.refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );
    return {
      ...tokens,
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1_000).toISOString(),
      scopes: data.scope ? String(data.scope).split(" ") : tokens.scopes,
      raw: { token_type: data.token_type },
    };
  }

  async disconnect(accessToken: string): Promise<void> {
    await jsonRequest(
      this.fetcher,
      `https://oauth2.googleapis.com/revoke?${new URLSearchParams({ token: accessToken })}`,
      {
        operation: "idempotent",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
  }

  async getAccountProfile(accessToken: string): Promise<AccountProfile> {
    const data = await jsonRequest<{
      items: Array<{
        id: string;
        snippet: {
          title: string;
          customUrl?: string;
          thumbnails?: { default?: { url: string } };
        };
      }>;
    }>(
      this.fetcher,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      {
        operation: "read",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const channel = data.items[0];
    if (!channel)
      throw new Error("No YouTube channel is associated with this account");
    return {
      id: channel.id,
      username: channel.snippet.customUrl ?? channel.snippet.title,
      displayName: channel.snippet.title,
      ...(channel.snippet.thumbnails?.default?.url
        ? { avatarUrl: channel.snippet.thumbnails.default.url }
        : {}),
    };
  }

  getCapabilities(): PlatformCapabilities {
    return {
      platform: "youtube",
      contentTypes: ["short", "video"],
      supportsDirectPublicPublishing: this.config.apiAuditApproved,
      requiresAppReview: true,
      supportsStatusPolling: true,
      supportsChunkedUpload: true,
      analyticsMetrics: [
        "views",
        "likes",
        "comments",
        "shares",
        "estimatedMinutesWatched",
        "averageViewDuration",
        "subscribersGained",
      ],
      limitations: [
        "Unverified API projects created after 28 July 2020 upload videos as private until audit.",
        "Shorts use the normal videos.insert upload; YouTube determines Shorts eligibility from the media.",
        "Custom thumbnails require a verified channel and a separate thumbnails.set request.",
        "The Data API and Analytics API have independent quotas and metric availability delays.",
      ],
    };
  }

  validatePost(
    metadata: unknown,
    media: PublishInput["media"],
  ): ValidationResult {
    const parsed = youTubeMetadataSchema.safeParse(metadata);
    const errors = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));
    for (const item of media) errors.push(...validateMedia(item, "youtube"));
    const videos = media.filter((item) => item.mimeType.startsWith("video/"));
    const images = media.filter((item) => item.mimeType.startsWith("image/"));
    if (
      videos.length !== 1 ||
      images.length > 1 ||
      videos.length + images.length !== media.length
    ) {
      errors.push({
        field: "media",
        message:
          "YouTube requires one video and at most one custom-thumbnail image.",
      });
    }
    if (parsed.success && parsed.data.thumbnailMediaId) {
      const thumbnail = images.find(
        (item) => item.id === parsed.data.thumbnailMediaId,
      );
      if (!thumbnail) {
        errors.push({
          field: "thumbnailMediaId",
          message: "Select an uploaded thumbnail image.",
        });
      } else if (
        thumbnail.sizeBytes > 2 * 1024 * 1024 ||
        !["image/jpeg", "image/png"].includes(thumbnail.mimeType)
      ) {
        errors.push({
          field: "thumbnailMediaId",
          message:
            "YouTube thumbnails must be JPEG/PNG and no larger than 2 MB.",
        });
      }
    }
    if (
      parsed.success &&
      parsed.data.privacyStatus === "public" &&
      !this.config.apiAuditApproved
    ) {
      errors.push({
        field: "privacyStatus",
        message:
          "Public YouTube upload is blocked until the API project audit is approved.",
      });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async publish(input: PublishInput) {
    const metadata = input.metadata as YouTubeMetadata;
    if (metadata.privacyStatus === "public" && !this.config.apiAuditApproved) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: { blocked: "youtube_api_audit_pending" },
        error: {
          code: "audit_required",
          message:
            "YouTube public uploads require an approved API compliance audit.",
          retryable: false,
        },
      };
    }
    const source = input.media.find((item) =>
      item.mimeType.startsWith("video/"),
    );
    if (!source) throw new Error("YouTube video media is missing");
    const response = await providerRequest(
      this.fetcher,
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        operation: "publish",
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(source.sizeBytes),
          "X-Upload-Content-Type": source.mimeType,
        },
        body: JSON.stringify({
          snippet: {
            title: metadata.title,
            description: metadata.description,
            categoryId: metadata.categoryId,
            tags: metadata.tags,
          },
          status: {
            privacyStatus: metadata.privacyStatus,
            selfDeclaredMadeForKids: metadata.madeForKids,
            containsSyntheticMedia: metadata.containsSyntheticMedia,
          },
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw providerHttpError(
        response.status,
        { message: body.slice(0, 500) },
        "publish",
      );
    }
    const sessionUrl = response.headers.get("Location");
    if (!sessionUrl)
      throw {
        code: "missing_upload_location",
        message: "YouTube did not return a resumable upload location",
        retryable: false,
        ambiguous: true,
      };
    const trustedSessionUrl = trustedUploadSessionUrl("youtube", sessionUrl);
    return {
      outcome: "processing" as const,
      uploadSession: {
        url: trustedSessionUrl,
        nextByte: 0,
        totalBytes: source.sizeBytes,
        chunkSize: Math.min(source.sizeBytes, 8 * 1024 * 1024),
      },
      sanitizedResponse: {
        uploadSessionCreated: true,
        nextByte: 0,
        totalBytes: source.sizeBytes,
      },
    };
  }

  async getPublishStatus(accessToken: string, statusHandle: string) {
    if (!/^[a-zA-Z0-9_-]{6,64}$/.test(statusHandle))
      throw new Error("YouTube status handle is invalid");
    const result = await jsonRequest<{
      items: Array<{
        id: string;
        status: { uploadStatus: string; rejectionReason?: string };
      }>;
    }>(
      this.fetcher,
      `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(statusHandle)}`,
      {
        operation: "read",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const video = result.items[0];
    if (video?.status.uploadStatus === "processed") {
      return {
        outcome: "published" as const,
        remoteContentId: video.id,
        remoteUrl: `https://youtu.be/${video.id}`,
        sanitizedResponse: video.status,
      };
    }
    if (
      video?.status.uploadStatus === "rejected" ||
      video?.status.uploadStatus === "failed"
    ) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: video.status,
        error: {
          code: video.status.rejectionReason ?? "upload_failed",
          message: "YouTube rejected the uploaded video.",
          retryable: false,
        },
      };
    }
    return {
      outcome: "processing" as const,
      statusHandle,
      sanitizedResponse: video?.status ?? {},
    };
  }

  async fetchAnalytics(request: AnalyticsRequest) {
    const params = new URLSearchParams({
      ids: "channel==MINE",
      startDate: request.startDate,
      endDate: request.endDate,
      metrics:
        "views,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,subscribersGained",
      ...(request.remoteContentId
        ? { filters: `video==${request.remoteContentId}` }
        : {}),
    });
    const result = await jsonRequest<{
      columnHeaders: Array<{ name: string }>;
      rows?: number[][];
    }>(
      this.fetcher,
      `https://youtubeanalytics.googleapis.com/v2/reports?${params.toString()}`,
      {
        operation: "read",
        headers: { Authorization: `Bearer ${request.accessToken}` },
      },
    );
    const row = result.rows?.[0] ?? [];
    const raw = Object.fromEntries(
      result.columnHeaders.map((header, index) => [header.name, row[index]]),
    );
    return normalizeAnalytics("youtube", raw);
  }

  async uploadThumbnail(
    accessToken: string,
    videoId: string,
    body: BodyInit,
    mimeType: string,
  ): Promise<void> {
    const response = await providerRequest(
      this.fetcher,
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
      {
        operation: "idempotent",
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": mimeType,
        },
        body,
      },
    );
    if (!response.ok) {
      throw providerHttpError(
        response.status,
        { message: (await response.text().catch(() => "")).slice(0, 500) },
        "idempotent",
      );
    }
  }

  normalizeError(error: unknown): PlatformError {
    return genericNormalizeError(error);
  }
}
