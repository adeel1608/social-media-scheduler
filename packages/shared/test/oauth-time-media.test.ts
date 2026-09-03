import { describe, expect, it } from "vitest";

import {
  createOAuthState,
  createPostSchema,
  createPkceChallenge,
  createPkceVerifier,
  isOAuthStateValid,
  localMelbourneToUtc,
  shouldUseMultipart,
  utcToMelbourne,
  validateMedia,
} from "../src";

describe("OAuth state and PKCE", () => {
  it("generates URL-safe, high-entropy values and S256 challenges", async () => {
    const state = createOAuthState();
    const verifier = createPkceVerifier();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(await createPkceChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects expired, consumed, and mismatched state", () => {
    const record = { state: "expected", expiresAt: "2026-09-03T01:10:00Z" };
    expect(
      isOAuthStateValid(record, "expected", new Date("2026-09-03T01:00:00Z")),
    ).toBe(true);
    expect(
      isOAuthStateValid(record, "wrong", new Date("2026-09-03T01:00:00Z")),
    ).toBe(false);
    expect(
      isOAuthStateValid(record, "expected", new Date("2026-09-03T01:20:00Z")),
    ).toBe(false);
    expect(
      isOAuthStateValid(
        { ...record, consumedAt: "2026-09-03T01:01:00Z" },
        "expected",
        new Date("2026-09-03T01:02:00Z"),
      ),
    ).toBe(false);
  });
});

describe("Melbourne scheduling", () => {
  it("stores ordinary local time as UTC and converts back", () => {
    const result = localMelbourneToUtc("2026-09-03T09:30");
    expect(result).toMatchObject({
      valid: true,
      utc: "2026-09-02T23:30:00.000Z",
    });
    expect(utcToMelbourne(result.utc!)).toContain("2026-09-03T09:30:00");
  });

  it("rejects nonexistent spring-forward time", () => {
    expect(localMelbourneToUtc("2026-10-04T02:30")).toMatchObject({
      valid: false,
      ambiguous: false,
    });
  });

  it("rejects ambiguous autumn time instead of guessing", () => {
    expect(localMelbourneToUtc("2026-04-05T02:30")).toMatchObject({
      valid: false,
      ambiguous: true,
    });
  });
});

describe("media validation", () => {
  it("rejects invalid MIME types and Instagram WebP", () => {
    expect(
      validateMedia({ mimeType: "application/pdf", sizeBytes: 10 }),
    ).not.toHaveLength(0);
    expect(
      validateMedia({ mimeType: "image/webp", sizeBytes: 10 }, "instagram"),
    ).toContainEqual(expect.objectContaining({ field: "mimeType" }));
  });

  it("selects multipart upload at 100 MB", () => {
    expect(shouldUseMultipart(99 * 1024 * 1024)).toBe(false);
    expect(shouldUseMultipart(100 * 1024 * 1024)).toBe(true);
  });
});

describe("post transaction input", () => {
  it("retains owner-selected account and media IDs per platform target", () => {
    const mediaId = "11111111-1111-4111-8111-111111111111";
    const accountId = "22222222-2222-4222-8222-222222222222";
    const parsed = createPostSchema.parse({
      title: "One source, independent target",
      baseCaption: "Caption",
      scheduledLocal: "2026-09-04T09:30",
      mediaIds: [mediaId],
      targets: [
        {
          platform: "instagram",
          connectedAccountId: accountId,
          mediaIds: [mediaId],
          metadata: { caption: "Override", contentType: "feed_image" },
        },
      ],
    });
    expect(parsed.targets[0]).toMatchObject({ connectedAccountId: accountId });
    expect(parsed.targets[0]?.mediaIds).toEqual([mediaId]);
  });
});
