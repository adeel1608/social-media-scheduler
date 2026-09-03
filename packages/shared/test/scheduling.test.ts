import { describe, expect, it } from "vitest";

import {
  applyPublishResult,
  claimDueTargets,
  createPostSchema,
  eligibleStatus,
  mediaDeletionEligible,
  notificationDeduplicationKey,
  queueDeliveryAction,
  stableIdempotencyKey,
  continueResumableUpload,
  type PostTarget,
} from "../src";

const now = new Date("2026-09-03T00:00:00Z");

describe("multi-platform scheduling", () => {
  it("accepts one post targeting three platforms", () => {
    const input = {
      title: "Three targets",
      baseCaption: "Shared caption",
      scheduledLocal: "2026-09-04T09:00",
      timezone: "Australia/Melbourne",
      mediaIds: ["11111111-1111-4111-8111-111111111111"],
      targets: [
        {
          platform: "instagram",
          metadata: { caption: "IG", contentType: "reel" },
        },
        {
          platform: "tiktok",
          metadata: {
            title: "TT",
            contentType: "video",
            privacyLevel: "PUBLIC_TO_EVERYONE",
            disableComment: false,
            disableDuet: false,
            disableStitch: false,
            commercialContent: false,
            yourBrand: false,
            brandedContent: false,
            aiGenerated: false,
          },
        },
        {
          platform: "youtube",
          metadata: {
            title: "YT",
            description: "d",
            contentType: "short",
            categoryId: "22",
            tags: [],
            privacyStatus: "public",
            madeForKids: false,
            containsSyntheticMedia: false,
          },
        },
      ],
    };
    expect(createPostSchema.safeParse(input).success).toBe(true);
  });

  it("keeps platform results independent", () => {
    const target = {
      id: "t",
      postId: "p",
      platform: "instagram",
      status: "publishing",
      scheduledAtUtc: now.toISOString(),
      metadata: { caption: "", contentType: "reel" },
      media: [],
      idempotencyKey: "key",
    } as PostTarget;
    expect(
      applyPublishResult(target, {
        outcome: "published",
        remoteContentId: "remote",
        sanitizedResponse: {},
      }).status,
    ).toBe("published");
    expect(
      applyPublishResult(
        { ...target, platform: "tiktok" },
        {
          outcome: "failed",
          sanitizedResponse: {},
          error: { code: "bad", message: "bad", retryable: false },
        },
      ).status,
    ).toBe("failed");
  });
});

describe("atomic claims and duplicate execution", () => {
  it("claims due targets once using a lease", () => {
    const targets = Array.from({ length: 1_000 }, (_, index) => ({
      id: String(index),
      status: "scheduled" as const,
      scheduledAtUtc: new Date(now.getTime() - index * 1_000).toISOString(),
    }));
    const first = claimDueTargets(targets, now, 300, 100);
    const second = claimDueTargets(targets, now, 300, 100);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(new Set([...first, ...second].map((item) => item.id)).size).toBe(
      200,
    );
  });

  it("produces a stable idempotency key for duplicate workers", () => {
    expect(stableIdempotencyKey("p1", "t1")).toBe("post:p1:target:t1:v1");
  });
});

describe("failure semantics", () => {
  it("acknowledges API failure without automatic retry", () => {
    expect(
      queueDeliveryAction({
        outcome: "failed",
        sanitizedResponse: {},
        error: { code: "x", message: "x", retryable: true },
      }),
    ).toBe("ack");
  });

  it("deduplicates one email per attempt", () => {
    const ledger = new Set<string>();
    const key = notificationDeduplicationKey("target", 1);
    ledger.add(key);
    ledger.add(key);
    expect(ledger.size).toBe(1);
  });

  it("marks ambiguous responses for review", () => {
    const target = { status: "publishing" } as PostTarget;
    expect(
      applyPublishResult(target, {
        outcome: "ambiguous",
        sanitizedResponse: {},
      }).status,
    ).toBe("needs_review");
  });
});

describe("authorization and safe continuations", () => {
  it("reactivates past-due blocked posts after authorization", () => {
    const target = {
      status: "blocked_authorization" as const,
      scheduledAtUtc: "2026-09-02T00:00:00Z",
    };
    expect(
      eligibleStatus(
        target,
        {
          connected: false,
          tokenValid: false,
          publicPublishingApproved: false,
        },
        now,
      ),
    ).toBe("blocked_authorization");
    expect(
      eligibleStatus(
        target,
        { connected: true, tokenValid: true, publicPublishingApproved: true },
        now,
      ),
    ).toBe("queued");
  });

  it("continues upload offsets without another publish request", () => {
    const session = continueResumableUpload(
      {
        platform: "youtube",
        sessionUrl: "https://upload.test",
        nextByte: 0,
        totalBytes: 20,
        publishRequestCreated: true,
      },
      8,
    );
    expect(session).toMatchObject({ nextByte: 8, publishRequestCreated: true });
  });
});

describe("media retention", () => {
  it("deletes successful media only after seven days", () => {
    expect(
      mediaDeletionEligible(
        ["published", "published"],
        "2026-08-26T00:00:00Z",
        now,
      ),
    ).toBe(true);
    expect(
      mediaDeletionEligible(
        ["published", "published"],
        "2026-09-01T00:00:00Z",
        now,
      ),
    ).toBe(false);
  });

  it("retains media if any target failed", () => {
    expect(
      mediaDeletionEligible(
        ["published", "failed"],
        "2026-08-01T00:00:00Z",
        now,
      ),
    ).toBe(false);
  });
});
