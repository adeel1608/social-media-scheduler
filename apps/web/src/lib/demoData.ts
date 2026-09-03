import type { Platform, TargetStatus } from "@scheduler/shared";

export interface DemoTarget {
  id: string;
  title: string;
  caption: string;
  platform: Platform;
  status: TargetStatus;
  scheduledAt: string;
  type: string;
  color: string;
  remoteUrl?: string;
  error?: string;
}

const baseTargets: DemoTarget[] = [
  {
    id: "q1",
    title: "Three ways to reset your creative energy",
    caption: "A practical reset for the days when ideas feel far away.",
    platform: "instagram",
    status: "scheduled",
    scheduledAt: "2026-09-03T09:30:00+10:00",
    type: "Carousel · 6 slides",
    color: "coral",
  },
  {
    id: "q2",
    title: "Studio morning — 30 second process",
    caption: "From blank canvas to the first confident line.",
    platform: "tiktok",
    status: "blocked_authorization",
    scheduledAt: "2026-09-03T11:15:00+10:00",
    type: "Video · 00:34",
    color: "ink",
  },
  {
    id: "q3",
    title: "Studio morning — 30 second process",
    caption: "The small rituals behind a better creative day.",
    platform: "youtube",
    status: "scheduled",
    scheduledAt: "2026-09-03T11:15:00+10:00",
    type: "Short · 00:34",
    color: "blue",
  },
  {
    id: "q4",
    title: "September desk notes",
    caption: "A quiet look around the workspace this month.",
    platform: "instagram",
    status: "scheduled",
    scheduledAt: "2026-09-04T14:00:00+10:00",
    type: "Reel · 00:47",
    color: "sage",
  },
  {
    id: "q5",
    title: "The 5-minute layout rule",
    caption: "One constraint that makes every composition stronger.",
    platform: "youtube",
    status: "scheduled",
    scheduledAt: "2026-09-05T10:00:00+10:00",
    type: "Video · 08:12",
    color: "gold",
  },
  {
    id: "q6",
    title: "Sunday field notes",
    caption: "Textures, colours and ideas collected on a slow walk.",
    platform: "tiktok",
    status: "blocked_authorization",
    scheduledAt: "2026-09-06T18:30:00+10:00",
    type: "Photo · 8 images",
    color: "lilac",
  },
];

export const demoQueue: DemoTarget[] = Array.from(
  { length: 2_487 },
  (_, index) => {
    const base = baseTargets[index % baseTargets.length]!;
    const date = new Date(base.scheduledAt);
    date.setDate(date.getDate() + Math.floor(index / baseTargets.length));
    return {
      ...base,
      id: `${base.id}-${index}`,
      scheduledAt: date.toISOString(),
    };
  },
);

export const publishedTargets: DemoTarget[] = [
  {
    id: "p1",
    title: "Designing a calmer Monday",
    caption: "Five systems that protect focus.",
    platform: "instagram",
    status: "published",
    scheduledAt: "2026-09-02T08:30:00+10:00",
    type: "Carousel",
    color: "coral",
    remoteUrl: "https://instagram.com",
  },
  {
    id: "p2",
    title: "Colour study no. 14",
    caption: "Working with the colours already in the room.",
    platform: "tiktok",
    status: "published",
    scheduledAt: "2026-09-01T17:45:00+10:00",
    type: "Video",
    color: "lilac",
    remoteUrl: "https://tiktok.com",
  },
  {
    id: "p3",
    title: "A complete creative reset",
    caption: "Build a repeatable weekly reset.",
    platform: "youtube",
    status: "published",
    scheduledAt: "2026-08-30T10:00:00+10:00",
    type: "Video",
    color: "blue",
    remoteUrl: "https://youtube.com",
  },
];

export const failedTargets: DemoTarget[] = [
  {
    id: "f1",
    title: "Studio morning — 30 second process",
    caption: "Short-form process clip.",
    platform: "tiktok",
    status: "failed",
    scheduledAt: "2026-09-02T11:15:00+10:00",
    type: "Video",
    color: "ink",
    error:
      "Creator privacy settings changed after scheduling. Review the available privacy options.",
  },
  {
    id: "f2",
    title: "August materials round-up",
    caption: "The tools worth keeping close.",
    platform: "instagram",
    status: "needs_review",
    scheduledAt: "2026-08-31T16:00:00+10:00",
    type: "Carousel",
    color: "gold",
    error:
      "The connection closed after the publish request. Check Instagram before retrying.",
  },
  {
    id: "f3",
    title: "What I learned from 100 sketches",
    caption: "A longer reflection on repetition.",
    platform: "youtube",
    status: "failed",
    scheduledAt: "2026-08-29T09:00:00+10:00",
    type: "Video",
    color: "sage",
    error:
      "The access token expired before the upload session started. Reconnect YouTube.",
  },
];
