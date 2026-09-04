import { describe, expect, it, vi } from "vitest";

import { InstagramAdapter, TikTokAdapter, YouTubeAdapter } from "../src";

const image = {
  id: "11111111-1111-4111-8111-111111111111",
  objectKey: "owner/random/image.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 1_000,
};
const video = {
  id: "22222222-2222-4222-8222-222222222222",
  objectKey: "owner/random/video.mp4",
  mimeType: "video/mp4",
  sizeBytes: 5_000_000,
};

describe("official API adapters", () => {
  it("uses Meta's container then media_publish workflow", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "container-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status_code: "FINISHED" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "media-1" }), { status: 200 }),
      );
    const adapter = new InstagramAdapter(
      { appId: "app", appSecret: "secret", reviewApproved: true },
      fetcher,
    );
    const result = await adapter.publish({
      accountId: "ig-user",
      accessToken: "token",
      idempotencyKey: "key",
      metadata: {
        caption: "Caption",
        altText: "Alt",
        contentType: "feed_image",
      },
      media: [image],
      deliveryUrls: ["https://media.example.test/image.jpg?signature=x"],
    });
    expect(result).toMatchObject({
      outcome: "processing",
    });
    expect(result.statusHandle).toMatch(/^ig1\./);
    expect(fetcher.mock.calls[0]?.[0]).toContain("graph.instagram.com");
    const published = await adapter.getPublishStatus(
      "token",
      result.statusHandle!,
    );
    expect(published).toMatchObject({
      outcome: "published",
      remoteContentId: "media-1",
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain("container-1");
    expect(fetcher.mock.calls[2]?.[0]).toContain("media_publish");
  });

  it("waits for carousel children before creating and publishing the parent", async () => {
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "child-1" }))
      .mockResolvedValueOnce(response({ id: "child-2" }))
      .mockResolvedValueOnce(response({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(response({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(response({ id: "parent-1" }))
      .mockResolvedValueOnce(response({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(response({ id: "media-2" }));
    const adapter = new InstagramAdapter(
      { appId: "app", appSecret: "secret", reviewApproved: true },
      fetcher,
    );
    const created = await adapter.publish({
      accountId: "ig-user",
      accessToken: "token",
      idempotencyKey: "carousel-key",
      metadata: { caption: "Carousel", contentType: "carousel" },
      media: [image, { ...image, id: "33333333-3333-4333-8333-333333333333" }],
      deliveryUrls: ["https://media.test/1", "https://media.test/2"],
    });
    const parent = await adapter.getPublishStatus(
      "token",
      created.statusHandle!,
    );
    expect(parent).toMatchObject({ outcome: "processing" });
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    const published = await adapter.getPublishStatus(
      "token",
      parent.statusHandle!,
    );
    expect(published).toMatchObject({
      outcome: "published",
      remoteContentId: "media-2",
    });
    expect(fetcher.mock.calls[6]?.[0]).toContain("media_publish");
  });

  it("blocks TikTok public posting before audit instead of silently using private", async () => {
    const adapter = new TikTokAdapter({
      clientKey: "key",
      clientSecret: "secret",
      contentPostingAudited: false,
    });
    const metadata = {
      title: "Video",
      contentType: "video" as const,
      privacyLevel: "PUBLIC_TO_EVERYONE" as const,
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      commercialContent: false,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    };
    expect(adapter.validatePost(metadata, [video]).errors).toContainEqual(
      expect.objectContaining({ field: "privacyLevel" }),
    );
    await expect(
      adapter.publish({
        accountId: "u",
        accessToken: "t",
        idempotencyKey: "k",
        metadata,
        media: [video],
        deliveryUrls: ["https://media.test/v"],
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: { code: "audit_required" },
    });
  });

  it("requires video duration before scheduling a TikTok post", () => {
    const adapter = new TikTokAdapter({
      clientKey: "key",
      clientSecret: "secret",
      contentPostingAudited: false,
    });
    const result = adapter.validatePost(
      {
        title: "Video",
        contentType: "video",
        privacyLevel: "SELF_ONLY",
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
        commercialContent: false,
        yourBrand: false,
        brandedContent: false,
        aiGenerated: false,
      },
      [video],
    );

    expect(result.errors).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("duration") }),
    );
  });

  it("enforces the latest TikTok creator duration limit before upload", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            privacy_level_options: ["SELF_ONLY"],
            max_video_post_duration_sec: 60,
            comment_disabled: false,
            duet_disabled: false,
            stitch_disabled: false,
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = new TikTokAdapter(
      {
        clientKey: "key",
        clientSecret: "secret",
        contentPostingAudited: false,
      },
      fetcher,
    );
    const result = await adapter.publish({
      accountId: "u",
      accessToken: "t",
      idempotencyKey: "k",
      metadata: {
        title: "Video",
        contentType: "video",
        privacyLevel: "SELF_ONLY",
        disableComment: false,
        disableDuet: false,
        disableStitch: false,
        commercialContent: false,
        yourBrand: false,
        brandedContent: false,
        aiGenerated: false,
      },
      media: [{ ...video, durationSeconds: 61 }],
      deliveryUrls: ["https://media.test/v"],
    });

    expect(result).toMatchObject({
      outcome: "failed",
      sanitizedResponse: {
        blocked: "creator_restriction",
        field: "media",
      },
      error: { code: "creator_restriction" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces disabled TikTok creator interactions before upload", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            privacy_level_options: ["SELF_ONLY"],
            max_video_post_duration_sec: 120,
            comment_disabled: true,
            duet_disabled: false,
            stitch_disabled: false,
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = new TikTokAdapter(
      {
        clientKey: "key",
        clientSecret: "secret",
        contentPostingAudited: false,
      },
      fetcher,
    );
    const result = await adapter.publish({
      accountId: "u",
      accessToken: "t",
      idempotencyKey: "k",
      metadata: {
        title: "Video",
        contentType: "video",
        privacyLevel: "SELF_ONLY",
        disableComment: false,
        disableDuet: false,
        disableStitch: false,
        commercialContent: false,
        yourBrand: false,
        brandedContent: false,
        aiGenerated: false,
      },
      media: [{ ...video, durationSeconds: 30 }],
      deliveryUrls: ["https://media.test/v"],
    });

    expect(result).toMatchObject({
      outcome: "failed",
      sanitizedResponse: {
        blocked: "creator_restriction",
        field: "disableComment",
      },
      error: { code: "creator_restriction" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks public YouTube upload before API audit", async () => {
    const adapter = new YouTubeAdapter({
      clientId: "id",
      clientSecret: "secret",
      apiAuditApproved: false,
    });
    const metadata = {
      title: "Video",
      description: "Description",
      contentType: "video" as const,
      categoryId: "22",
      tags: [],
      privacyStatus: "public" as const,
      madeForKids: false,
      containsSyntheticMedia: false,
    };
    expect(adapter.validatePost(metadata, [video]).valid).toBe(false);
    await expect(
      adapter.publish({
        accountId: "u",
        accessToken: "t",
        idempotencyKey: "k",
        metadata,
        media: [video],
        deliveryUrls: [],
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      error: { code: "audit_required" },
    });
  });

  it("normalizes network ambiguity without leaking bearer tokens", () => {
    const adapter = new InstagramAdapter({
      appId: "app",
      appSecret: "secret",
      reviewApproved: true,
    });
    expect(
      adapter.normalizeError({
        name: "NetworkError",
        code: "network_error",
        message: "Bearer very-secret",
        ambiguous: true,
      }),
    ).toMatchObject({
      code: "network_error",
      message: "Bearer [REDACTED]",
      ambiguous: true,
      retryable: false,
    });
  });

  it("publishes YouTube through a resumable session, never buffering the media", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { Location: "https://upload.youtube.test/session" },
      }),
    );
    const adapter = new YouTubeAdapter(
      { clientId: "id", clientSecret: "secret", apiAuditApproved: true },
      fetcher,
    );
    const result = await adapter.publish({
      accountId: "u",
      accessToken: "t",
      idempotencyKey: "k",
      metadata: {
        title: "Video",
        description: "D",
        contentType: "video",
        categoryId: "22",
        tags: [],
        privacyStatus: "public",
        madeForKids: false,
        containsSyntheticMedia: false,
      },
      media: [video],
      deliveryUrls: [],
    });
    expect(result.uploadSession).toMatchObject({
      url: "https://upload.youtube.test/session",
      nextByte: 0,
      totalBytes: video.sizeBytes,
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toBeInstanceOf(ArrayBuffer);
  });

  it("uses the official custom-thumbnail upload endpoint", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    const adapter = new YouTubeAdapter(
      { clientId: "id", clientSecret: "secret", apiAuditApproved: true },
      fetcher,
    );
    await adapter.uploadThumbnail(
      "token",
      "video-id",
      new Blob(["image"]),
      "image/png",
    );
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      "/youtube/v3/thumbnails/set?videoId=video-id&uploadType=media",
    );
  });
});
