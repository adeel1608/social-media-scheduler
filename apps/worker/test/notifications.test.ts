import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { sendFailureEmailOnce } from "../src/notifications";

const input = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  postTitle: "Owner post",
  platform: "youtube",
  scheduledAt: "2026-09-04T00:00:00.000Z",
  status: "needs_review" as const,
  safeMessage:
    "Bearer secret-token at https://upload.example/path?signature=secret",
  attempt: 3,
};

const env = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-sentinel",
  APP_URL: "https://postline.pages.dev",
  RESEND_API_KEY: "resend-key-sentinel",
  RESEND_FROM: "Postline <alerts@postline.dev>",
  NOTIFICATION_EMAIL: "owner@postline.dev",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("failure notification idempotency", () => {
  it("uses database and Resend idempotency while redacting message details", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const resendRequest = fetcher.mock.calls[1]!;
    expect(resendRequest[0]).toBe("https://api.resend.com/emails");
    expect(new Headers(resendRequest[1]?.headers).get("Idempotency-Key")).toBe(
      "failure:22222222-2222-4222-8222-222222222222:attempt:3",
    );
    const body = String(resendRequest[1]?.body);
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("upload.example");
    expect(body).toContain("[REDACTED_URL]");
  });

  it("does not send when the database deduplication row already exists", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
