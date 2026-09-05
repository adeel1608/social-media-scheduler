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
    const input = {
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
    };
    const result = await adapter.publish(input);
    expect(result).toMatchObject({
      outcome: "processing",
    });
    expect(result.statusHandle).toMatch(/^ig2\./);
    expect(fetcher.mock.calls[0]?.[0]).toContain("graph.instagram.com");
    const ready = await adapter.getPublishStatus("token", result.statusHandle!);
    expect(ready.nextProviderWrite).toEqual({
      phase: "instagram_media_publish",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const published = await adapter.executePublishWrite!(
      input,
      ready.statusHandle!,
      ready.nextProviderWrite!.phase,
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
      .mockResolvedValueOnce(response({ status_code: "FINISHED" }))
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
    const input = {
      accountId: "ig-user",
      accessToken: "token",
      idempotencyKey: "carousel-key",
      metadata: { caption: "Carousel", contentType: "carousel" },
      media: [image, { ...image, id: "33333333-3333-4333-8333-333333333333" }],
      deliveryUrls: ["https://media.test/1", "https://media.test/2"],
    };
    const created = await adapter.publish(input);
    const secondChildReady = await adapter.getPublishStatus(
      "token",
      created.statusHandle!,
    );
    expect(secondChildReady.nextProviderWrite?.phase).toBe(
      "instagram_child_container",
    );
    const secondChild = await adapter.executePublishWrite!(
      input,
      secondChildReady.statusHandle!,
      secondChildReady.nextProviderWrite!.phase,
    );
    const parentReady = await adapter.getPublishStatus(
      "token",
      secondChild.statusHandle!,
    );
    expect(parentReady.nextProviderWrite?.phase).toBe(
      "instagram_carousel_parent",
    );
    const parent = await adapter.executePublishWrite!(
      input,
      parentReady.statusHandle!,
      parentReady.nextProviderWrite!.phase,
    );
    expect(fetcher.mock.calls[5]?.[1]).toMatchObject({ method: "POST" });
    const publishReady = await adapter.getPublishStatus(
      "token",
      parent.statusHandle!,
    );
    expect(publishReady.nextProviderWrite?.phase).toBe(
      "instagram_media_publish",
    );
    const published = await adapter.executePublishWrite!(
      input,
      publishReady.statusHandle!,
      publishReady.nextProviderWrite!.phase,
    );
    expect(published).toMatchObject({
      outcome: "published",
      remoteContentId: "media-2",
    });
    expect(fetcher.mock.calls[7]?.[0]).toContain("media_publish");
  });

  it("treats a successful Meta write without its remote ID as ambiguous", async () => {
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ id: "container-1" }))
      .mockResolvedValueOnce(response({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(response({}));
    const adapter = new InstagramAdapter(
      { appId: "app", appSecret: "secret", reviewApproved: true },
      fetcher,
    );
    const input = {
      accountId: "ig-user",
      accessToken: "token",
      idempotencyKey: "key",
      metadata: {
        caption: "Caption",
        altText: "Alt",
        contentType: "feed_image" as const,
      },
      media: [image],
      deliveryUrls: ["https://media.example.test/image.jpg?signature=x"],
    };
    const created = await adapter.publish(input);
    const ready = await adapter.getPublishStatus(
      input.accessToken,
      created.statusHandle!,
    );

    let failure: unknown;
    try {
      await adapter.executePublishWrite!(
        input,
        ready.statusHandle!,
        ready.nextProviderWrite!.phase,
      );
    } catch (error) {
      failure = error;
    }
    expect(adapter.normalizeError(failure)).toMatchObject({
      code: "missing_remote_handle",
      retryable: false,
      ambiguous: true,
    });
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
    const result = await adapter.preflightPublish!({
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
    const result = await adapter.preflightPublish!({
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

  it.each([
    ["network", undefined],
    ["429", 429],
    ["5xx", 503],
  ] as const)(
    "keeps read-only TikTok creator-info POST %s failures safely retryable",
    async (_case, status) => {
      const fetcher = vi.fn<typeof fetch>();
      if (status) {
        fetcher.mockResolvedValueOnce(new Response("{}", { status }));
      } else {
        fetcher.mockRejectedValueOnce(new Error("network unavailable"));
      }
      const adapter = new TikTokAdapter(
        {
          clientKey: "key",
          clientSecret: "secret",
          contentPostingAudited: false,
        },
        fetcher,
      );

      let failure: unknown;
      try {
        await adapter.preflightPublish!({
          accountId: "u",
          accessToken: "t",
          idempotencyKey: "k",
          metadata: {
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
          media: [{ ...video, durationSeconds: 30 }],
          deliveryUrls: ["https://media.test/v"],
        });
      } catch (error) {
        failure = error;
      }
      expect(adapter.normalizeError(failure)).toMatchObject({
        retryable: true,
        ambiguous: false,
      });
    },
  );

  it.each([
    ["network", undefined],
    ["429", 429],
    ["5xx", 503],
  ] as const)(
    "keeps read-only TikTok status POST %s failures safely retryable",
    async (_case, status) => {
      const fetcher = vi.fn<typeof fetch>();
      if (status) {
        fetcher.mockResolvedValueOnce(new Response("{}", { status }));
      } else {
        fetcher.mockRejectedValueOnce(new Error("network unavailable"));
      }
      const adapter = new TikTokAdapter(
        {
          clientKey: "key",
          clientSecret: "secret",
          contentPostingAudited: false,
        },
        fetcher,
      );

      let failure: unknown;
      try {
        await adapter.getPublishStatus("token", "handle");
      } catch (error) {
        failure = error;
      }
      expect(adapter.normalizeError(failure)).toMatchObject({
        retryable: true,
        ambiguous: false,
      });
    },
  );

  it("sends TikTok photo AI disclosure at the documented top level", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              privacy_level_options: ["SELF_ONLY"],
              max_video_post_duration_sec: 120,
              comment_disabled: false,
              duet_disabled: false,
              stitch_disabled: false,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { publish_id: "photo-publish-id" },
            error: { code: "ok" },
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
    const input = {
      accountId: "u",
      accessToken: "t",
      idempotencyKey: "k",
      metadata: {
        title: "Photo",
        description: "Description",
        contentType: "photo",
        privacyLevel: "SELF_ONLY",
        disableComment: false,
        disableDuet: true,
        disableStitch: true,
        commercialContent: false,
        yourBrand: false,
        brandedContent: false,
        aiGenerated: true,
      },
      media: [image],
      deliveryUrls: ["https://media.test/photo"],
    };
    await expect(adapter.preflightPublish!(input)).resolves.toBeNull();
    const result = await adapter.publish(input);

    expect(result).toMatchObject({
      outcome: "processing",
      statusHandle: "photo-publish-id",
    });
    const payload = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ is_aigc: true });
    expect(payload.post_info).not.toHaveProperty("is_aigc");
  });

  it("treats an uncertain TikTok publish-init 5xx as ambiguous", async () => {
    const adapter = new TikTokAdapter(
      {
        clientKey: "key",
        clientSecret: "secret",
        contentPostingAudited: false,
      },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status: 503 })),
    );
    let failure: unknown;
    try {
      await adapter.publish({
        accountId: "u",
        accessToken: "t",
        idempotencyKey: "k",
        metadata: {
          title: "Photo",
          description: "Description",
          contentType: "photo",
          privacyLevel: "SELF_ONLY",
          disableComment: true,
          disableDuet: true,
          disableStitch: true,
          commercialContent: false,
          yourBrand: false,
          brandedContent: false,
          aiGenerated: false,
        },
        media: [image],
        deliveryUrls: ["https://media.test/photo"],
      });
    } catch (error) {
      failure = error;
    }

    expect(adapter.normalizeError(failure)).toMatchObject({
      httpStatus: 503,
      retryable: false,
      ambiguous: true,
    });
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
        headers: {
          Location:
            "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session",
        },
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
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session",
      nextByte: 0,
      totalBytes: video.sizeBytes,
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toBeInstanceOf(ArrayBuffer);
  });

  it("treats an uncertain YouTube resumable-init 5xx as ambiguous", async () => {
    const adapter = new YouTubeAdapter(
      { clientId: "id", clientSecret: "secret", apiAuditApproved: true },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status: 503 })),
    );
    let failure: unknown;
    try {
      await adapter.publish({
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
    } catch (error) {
      failure = error;
    }

    expect(adapter.normalizeError(failure)).toMatchObject({
      httpStatus: 503,
      retryable: false,
      ambiguous: true,
    });
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
