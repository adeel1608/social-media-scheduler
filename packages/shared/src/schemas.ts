import { z } from "zod";

import { platforms, targetStatuses } from "./types";

export const platformSchema = z.enum(platforms);
export const targetStatusSchema = z.enum(targetStatuses);

export const mediaDescriptorSchema = z.object({
  id: z.string().uuid(),
  objectKey: z.string().min(12).max(512),
  mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]+$/i),
  sizeBytes: z.number().int().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
});

export const createMediaUploadSchema = mediaDescriptorSchema
  .pick({
    mimeType: true,
    sizeBytes: true,
    width: true,
    height: true,
    durationSeconds: true,
  })
  .extend({ filename: z.string().min(1).max(255) });

export const instagramMetadataSchema = z.object({
  caption: z.string().max(2_200),
  altText: z.string().max(1_000).optional(),
  contentType: z.enum([
    "feed_image",
    "video",
    "carousel",
    "reel",
    "story_image",
    "story_video",
  ]),
});

export const tikTokMetadataSchema = z
  .object({
    title: z.string().min(1).max(150),
    description: z.string().max(2_200).optional(),
    contentType: z.enum(["video", "photo"]),
    privacyLevel: z.enum([
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ]),
    disableComment: z.boolean(),
    disableDuet: z.boolean(),
    disableStitch: z.boolean(),
    commercialContent: z.boolean(),
    yourBrand: z.boolean(),
    brandedContent: z.boolean(),
    aiGenerated: z.boolean(),
    autoAddMusic: z.boolean().optional(),
    creatorPrivacyOptions: z.array(z.string()).optional(),
  })
  .superRefine((value, context) => {
    if (value.commercialContent && !value.yourBrand && !value.brandedContent) {
      context.addIssue({
        code: "custom",
        path: ["commercialContent"],
        message:
          "Commercial content must identify your brand or branded content.",
      });
    }
    if (
      value.creatorPrivacyOptions &&
      !value.creatorPrivacyOptions.includes(value.privacyLevel)
    ) {
      context.addIssue({
        code: "custom",
        path: ["privacyLevel"],
        message:
          "Privacy must be one of the creator's current API-provided options.",
      });
    }
  });

export const youTubeMetadataSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(5_000),
  contentType: z.enum(["short", "video"]),
  categoryId: z.string().regex(/^\d+$/),
  tags: z.array(z.string().min(1).max(500)).max(50),
  privacyStatus: z.enum(["public", "unlisted", "private"]),
  madeForKids: z.boolean(),
  containsSyntheticMedia: z.boolean(),
  thumbnailMediaId: z.string().uuid().optional(),
});

export const createPostSchema = z.object({
  title: z.string().min(1).max(180),
  baseCaption: z.string().max(5_000),
  scheduledLocal: z.string().min(1),
  timezone: z.literal("Australia/Melbourne").default("Australia/Melbourne"),
  mediaIds: z.array(z.string().uuid()).min(1),
  targets: z
    .array(
      z.discriminatedUnion("platform", [
        z.object({
          platform: z.literal("instagram"),
          connectedAccountId: z.string().uuid().optional(),
          mediaIds: z.array(z.string().uuid()).min(1).optional(),
          metadata: instagramMetadataSchema,
        }),
        z.object({
          platform: z.literal("tiktok"),
          connectedAccountId: z.string().uuid().optional(),
          mediaIds: z.array(z.string().uuid()).min(1).optional(),
          metadata: tikTokMetadataSchema,
        }),
        z.object({
          platform: z.literal("youtube"),
          connectedAccountId: z.string().uuid().optional(),
          mediaIds: z.array(z.string().uuid()).min(1).optional(),
          metadata: youTubeMetadataSchema,
        }),
      ]),
    )
    .min(1)
    .max(3)
    .superRefine((targets, context) => {
      const unique = new Set(targets.map((target) => target.platform));
      if (unique.size !== targets.length) {
        context.addIssue({
          code: "custom",
          message: "Each platform can be targeted once.",
        });
      }
    }),
});

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: targetStatusSchema.optional(),
  platform: platformSchema.optional(),
});
