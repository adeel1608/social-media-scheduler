import {
  instagramMetadataSchema,
  normalizeAnalytics,
  validateMedia,
  type InstagramMetadata,
} from "@scheduler/shared";

import { genericNormalizeError, jsonRequest } from "./http";
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

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  graphVersion?: string;
  reviewApproved: boolean;
}

interface InstagramPublishState {
  version: 2;
  phase: "children" | "parent";
  accountId: string;
  creationIds: string[];
  nextMediaIndex: number;
  mediaCount: number;
  contentType: InstagramMetadata["contentType"];
}

type InstagramWritePhase =
  | "instagram_child_container"
  | "instagram_carousel_parent"
  | "instagram_media_publish";

function encodePublishState(state: InstagramPublishState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `ig2.${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function decodePublishState(statusHandle: string): InstagramPublishState {
  const legacy = statusHandle.startsWith("ig1.");
  if (!legacy && !statusHandle.startsWith("ig2."))
    throw new Error("Unsupported Instagram publish status handle");
  const encoded = statusHandle.slice(4).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  const parsed = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    ),
  ) as Record<string, unknown>;
  const version = parsed.version;
  const phase = parsed.phase;
  const accountId = parsed.accountId;
  const creationIds = parsed.creationIds;
  const contentType = parsed.contentType;
  if (
    typeof version !== "number" ||
    ![1, 2].includes(version) ||
    typeof phase !== "string" ||
    !["children", "parent"].includes(phase) ||
    typeof accountId !== "string" ||
    !accountId ||
    !Array.isArray(creationIds) ||
    creationIds.length === 0 ||
    creationIds.length > 10 ||
    creationIds.some(
      (creationId) =>
        typeof creationId !== "string" ||
        !creationId ||
        creationId.length > 255,
    ) ||
    accountId.length > 255 ||
    typeof contentType !== "string"
  )
    throw new Error("Invalid Instagram publish status handle");
  const nextMediaIndex =
    version === 1 ? creationIds.length : parsed.nextMediaIndex;
  const mediaCount = version === 1 ? creationIds.length : parsed.mediaCount;
  if (
    typeof nextMediaIndex !== "number" ||
    !Number.isSafeInteger(nextMediaIndex) ||
    nextMediaIndex < 1 ||
    typeof mediaCount !== "number" ||
    !Number.isSafeInteger(mediaCount) ||
    mediaCount < nextMediaIndex ||
    mediaCount > 10 ||
    ![
      "feed_image",
      "video",
      "carousel",
      "reel",
      "story_image",
      "story_video",
    ].includes(contentType)
  ) {
    throw new Error("Invalid Instagram publish status handle");
  }
  return {
    version: 2,
    phase: phase as InstagramPublishState["phase"],
    accountId,
    creationIds: creationIds as string[],
    nextMediaIndex,
    mediaCount,
    contentType: contentType as InstagramMetadata["contentType"],
  };
}

function nextWritePhase(state: InstagramPublishState): InstagramWritePhase {
  if (state.phase === "children" && state.nextMediaIndex < state.mediaCount)
    return "instagram_child_container";
  if (state.phase === "children" && state.contentType === "carousel")
    return "instagram_carousel_parent";
  return "instagram_media_publish";
}

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = "instagram" as const;
  private readonly graphVersion: string;

  constructor(
    private readonly config: InstagramConfig,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.graphVersion = config.graphVersion ?? "v23.0";
  }

  getAuthorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({
      client_id: this.config.appId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      scope: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_insights",
      ].join(","),
      state: request.state,
      enable_fb_login: "0",
      force_authentication: "1",
    });
    return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    const short = await jsonRequest<{ access_token: string; user_id: number }>(
      this.fetcher,
      "https://api.instagram.com/oauth/access_token",
      { operation: "idempotent", method: "POST", body },
    );
    const longUrl = new URL(`https://graph.instagram.com/access_token`);
    longUrl.search = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: this.config.appSecret,
      access_token: short.access_token,
    }).toString();
    const long = await jsonRequest<{
      access_token: string;
      expires_in: number;
    }>(this.fetcher, longUrl.toString(), { operation: "idempotent" });
    return {
      accessToken: long.access_token,
      accountId: String(short.user_id),
      expiresAt: new Date(Date.now() + long.expires_in * 1_000).toISOString(),
      scopes: [
        "instagram_business_basic",
        "instagram_business_content_publish",
        "instagram_business_manage_insights",
      ],
      raw: { user_id: short.user_id, expires_in: long.expires_in },
    };
  }

  async refreshAccessToken(tokens: TokenSet): Promise<TokenSet> {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.search = new URLSearchParams({
      grant_type: "ig_refresh_token",
      access_token: tokens.accessToken,
    }).toString();
    const data = await jsonRequest<{
      access_token: string;
      expires_in: number;
    }>(this.fetcher, url.toString(), { operation: "idempotent" });
    return {
      ...tokens,
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1_000).toISOString(),
      raw: { expires_in: data.expires_in },
    };
  }

  async disconnect(accessToken: string): Promise<void> {
    const url = new URL("https://graph.instagram.com/me/permissions");
    url.searchParams.set("access_token", accessToken);
    await jsonRequest(this.fetcher, url.toString(), {
      operation: "idempotent",
      method: "DELETE",
    });
  }

  async getAccountProfile(accessToken: string): Promise<AccountProfile> {
    const url = new URL(`https://graph.instagram.com/${this.graphVersion}/me`);
    url.search = new URLSearchParams({
      fields: "id,username,name,account_type,profile_picture_url",
      access_token: accessToken,
    }).toString();
    const profile = await jsonRequest<Record<string, string>>(
      this.fetcher,
      url.toString(),
      { operation: "read" },
    );
    return {
      id: profile.id!,
      username: profile.username!,
      ...(profile.name ? { displayName: profile.name } : {}),
      ...(profile.profile_picture_url
        ? { avatarUrl: profile.profile_picture_url }
        : {}),
      ...(profile.account_type ? { accountType: profile.account_type } : {}),
    };
  }

  getCapabilities(): PlatformCapabilities {
    return {
      platform: "instagram",
      contentTypes: [
        "feed_image",
        "video",
        "carousel",
        "reel",
        "story_image",
        "story_video",
      ],
      supportsDirectPublicPublishing: this.config.reviewApproved,
      requiresAppReview: true,
      supportsStatusPolling: true,
      supportsChunkedUpload: true,
      analyticsMetrics: [
        "views",
        "reach",
        "impressions",
        "likes",
        "comments",
        "shares",
        "saved",
      ],
      limitations: [
        "Professional Instagram account required.",
        "Story publishing is limited to business accounts in the Facebook Login configuration.",
        "Media must be reachable by Meta while the container is created.",
        "Alt text is supported for image posts, not Reels or Stories.",
      ],
    };
  }

  validatePost(
    metadata: unknown,
    media: PublishInput["media"],
  ): ValidationResult {
    const parsed = instagramMetadataSchema.safeParse(metadata);
    const errors = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));
    for (const item of media) errors.push(...validateMedia(item, "instagram"));
    if (parsed.success) {
      const needed = parsed.data.contentType === "carousel" ? 2 : 1;
      if (
        media.length < needed ||
        media.length > (parsed.data.contentType === "carousel" ? 10 : 1)
      ) {
        errors.push({
          field: "media",
          message: `This Instagram type requires ${needed}${needed === 2 ? "–10" : ""} media item(s).`,
        });
      }
      const imageOnly = ["feed_image", "story_image"].includes(
        parsed.data.contentType,
      );
      const videoOnly = ["video", "reel", "story_video"].includes(
        parsed.data.contentType,
      );
      if (imageOnly && media.some((item) => item.mimeType !== "image/jpeg"))
        errors.push({
          field: "media",
          message: "This Instagram content type requires JPEG image media.",
        });
      if (
        videoOnly &&
        media.some((item) => !item.mimeType.startsWith("video/"))
      )
        errors.push({
          field: "media",
          message: "This Instagram content type requires video media.",
        });
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async publish(input: PublishInput) {
    if (!this.config.reviewApproved) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: { blocked: "meta_app_review_pending" },
        error: {
          code: "approval_required",
          message: "Meta app review is not marked approved.",
          retryable: false,
        },
      };
    }
    if (!input.media.length) throw new Error("Instagram media is missing");
    const metadata = input.metadata as InstagramMetadata;
    const containerId = await this.createMediaContainer(input, 0);
    return {
      outcome: "processing" as const,
      statusHandle: encodePublishState({
        version: 2,
        phase: "children",
        accountId: input.accountId,
        creationIds: [containerId],
        nextMediaIndex: 1,
        mediaCount: input.media.length,
        contentType: metadata.contentType,
      }),
      sanitizedResponse: {
        creationId: containerId,
        mediaIndex: 0,
        status: "container_created",
      },
    };
  }

  async getPublishStatus(accessToken: string, statusHandle: string) {
    const state = decodePublishState(statusHandle);
    const statuses = await Promise.all(
      state.creationIds.map(async (creationId) => {
        const url = new URL(
          `https://graph.instagram.com/${this.graphVersion}/${creationId}`,
        );
        url.search = new URLSearchParams({
          fields: "status_code,status",
          access_token: accessToken,
        }).toString();
        return jsonRequest<{ status_code: string; status?: string }>(
          this.fetcher,
          url.toString(),
          { operation: "read" },
        );
      }),
    );
    const terminalError = statuses.find(
      ({ status_code }) => status_code === "ERROR" || status_code === "EXPIRED",
    );
    if (terminalError) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: terminalError,
        error: {
          code: terminalError.status_code,
          message: "Instagram container processing failed.",
          retryable: false,
        },
      };
    }
    if (!statuses.every(({ status_code }) => status_code === "FINISHED")) {
      return {
        outcome: "processing" as const,
        statusHandle,
        sanitizedResponse: { statuses },
      };
    }

    const phase = nextWritePhase(state);
    return {
      outcome: "processing" as const,
      statusHandle,
      nextProviderWrite: { phase },
      sanitizedResponse: { statuses, nextPhase: phase },
    };
  }

  async executePublishWrite(
    input: PublishInput,
    statusHandle: string,
    phase: string,
  ) {
    if (!this.config.reviewApproved) {
      return {
        outcome: "failed" as const,
        sanitizedResponse: { blocked: "meta_app_review_pending" },
        error: {
          code: "approval_required",
          message: "Meta app review is not marked approved.",
          retryable: false,
        },
      };
    }
    const state = decodePublishState(statusHandle);
    if (state.accountId !== input.accountId)
      throw new Error("Instagram publish state account mismatch");
    const expectedPhase = nextWritePhase(state);
    if (phase !== expectedPhase)
      throw new Error("Instagram publish phase mismatch");
    const metadata = input.metadata as InstagramMetadata;

    if (expectedPhase === "instagram_child_container") {
      const mediaIndex = state.nextMediaIndex;
      const containerId = await this.createMediaContainer(input, mediaIndex);
      const nextState: InstagramPublishState = {
        ...state,
        creationIds: [...state.creationIds, containerId],
        nextMediaIndex: mediaIndex + 1,
      };
      return {
        outcome: "processing" as const,
        statusHandle: encodePublishState(nextState),
        sanitizedResponse: {
          creationId: containerId,
          mediaIndex,
          status: "container_created",
        },
      };
    }

    if (expectedPhase === "instagram_carousel_parent") {
      const carousel = await jsonRequest<{ id: string }>(
        this.fetcher,
        `https://graph.instagram.com/${this.graphVersion}/${state.accountId}/media`,
        {
          operation: "publish",
          method: "POST",
          body: new URLSearchParams({
            media_type: "CAROUSEL",
            children: state.creationIds.join(","),
            caption: metadata.caption,
            access_token: input.accessToken,
          }),
        },
      );
      if (!carousel.id)
        throw {
          code: "missing_remote_handle",
          message: "Instagram did not return a carousel container ID",
          retryable: false,
          ambiguous: true,
        };
      return {
        outcome: "processing" as const,
        statusHandle: encodePublishState({
          ...state,
          phase: "parent",
          creationIds: [carousel.id],
        }),
        sanitizedResponse: {
          creationId: carousel.id,
          status: "carousel_container_created",
        },
      };
    }

    const creationId = state.creationIds[0]!;
    const published = await jsonRequest<{ id: string }>(
      this.fetcher,
      `https://graph.instagram.com/${this.graphVersion}/${state.accountId}/media_publish`,
      {
        operation: "publish",
        method: "POST",
        body: new URLSearchParams({
          creation_id: creationId,
          access_token: input.accessToken,
        }),
      },
    );
    if (!published.id)
      throw {
        code: "missing_remote_handle",
        message: "Instagram did not return a published media ID",
        retryable: false,
        ambiguous: true,
      };
    let remoteUrl: string | undefined;
    try {
      const url = new URL(
        `https://graph.instagram.com/${this.graphVersion}/${published.id}`,
      );
      url.search = new URLSearchParams({
        fields: "permalink",
        access_token: input.accessToken,
      }).toString();
      const media = await jsonRequest<{ permalink?: string }>(
        this.fetcher,
        url.toString(),
        { operation: "read" },
      );
      remoteUrl = media.permalink;
    } catch {
      // Publication already succeeded; a nonessential permalink lookup cannot make it retryable.
    }
    return {
      outcome: "published" as const,
      remoteContentId: published.id,
      ...(remoteUrl ? { remoteUrl } : {}),
      sanitizedResponse: { id: published.id, creationId },
    };
  }

  private async createMediaContainer(
    input: PublishInput,
    index: number,
  ): Promise<string> {
    const metadata = input.metadata as InstagramMetadata;
    const media = input.media[index];
    const deliveryUrl = input.deliveryUrls[index];
    if (!media || !deliveryUrl)
      throw new Error("Instagram media state is incomplete");
    const params: Record<string, string> = {
      access_token: input.accessToken,
      ...(media.mimeType.startsWith("image/")
        ? { image_url: deliveryUrl }
        : { video_url: deliveryUrl }),
    };
    if (metadata.contentType === "carousel") params.is_carousel_item = "true";
    if (metadata.contentType === "video") params.media_type = "VIDEO";
    if (metadata.contentType === "reel") params.media_type = "REELS";
    if (["story_image", "story_video"].includes(metadata.contentType))
      params.media_type = "STORIES";
    if (
      metadata.contentType === "carousel" &&
      media.mimeType.startsWith("video/")
    )
      params.media_type = "VIDEO";
    if (
      metadata.caption &&
      metadata.contentType !== "carousel" &&
      metadata.contentType !== "story_image" &&
      metadata.contentType !== "story_video"
    )
      params.caption = metadata.caption;
    if (metadata.altText && metadata.contentType === "feed_image")
      params.alt_text = metadata.altText;
    const container = await jsonRequest<{ id: string }>(
      this.fetcher,
      `https://graph.instagram.com/${this.graphVersion}/${input.accountId}/media`,
      {
        operation: "publish",
        method: "POST",
        body: new URLSearchParams(params),
      },
    );
    if (!container.id)
      throw {
        code: "missing_remote_handle",
        message: "Instagram did not return a container ID",
        retryable: false,
        ambiguous: true,
      };
    return container.id;
  }

  async fetchAnalytics(request: AnalyticsRequest) {
    if (!request.remoteContentId) return normalizeAnalytics("instagram", {});
    const raw: Record<string, number | undefined> = {};
    const fieldsUrl = new URL(
      `https://graph.instagram.com/${this.graphVersion}/${request.remoteContentId}`,
    );
    fieldsUrl.search = new URLSearchParams({
      fields: "like_count,comments_count",
      access_token: request.accessToken,
    }).toString();
    try {
      Object.assign(
        raw,
        await jsonRequest<Record<string, number>>(
          this.fetcher,
          fieldsUrl.toString(),
          { operation: "read" },
        ),
      );
    } catch {
      // Counts unavailable for this media/account type remain explicitly unavailable.
    }
    await Promise.all(
      ["views", "reach", "impressions", "shares", "saved"].map(
        async (metricName) => {
          const url = new URL(
            `https://graph.instagram.com/${this.graphVersion}/${request.remoteContentId}/insights`,
          );
          url.search = new URLSearchParams({
            metric: metricName,
            access_token: request.accessToken,
          }).toString();
          try {
            const result = await jsonRequest<{
              data: Array<{
                name: string;
                values?: Array<{ value: number }>;
                total_value?: { value: number };
              }>;
            }>(this.fetcher, url.toString(), { operation: "read" });
            const metric = result.data[0];
            if (metric)
              raw[metric.name] =
                metric.total_value?.value ?? metric.values?.[0]?.value;
          } catch {
            // Instagram varies metrics by media type; one unsupported metric must not hide the rest.
          }
        },
      ),
    );
    return normalizeAnalytics("instagram", raw);
  }

  normalizeError(error: unknown): PlatformError {
    return genericNormalizeError(error);
  }
}
