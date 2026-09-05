import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import {
  retryFailedNotifications,
  sendFailureEmailOnce,
} from "../src/notifications";

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
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const resendRequest = fetcher.mock.calls[2]!;
    expect(resendRequest[0]).toBe("https://api.resend.com/emails");
    expect(new Headers(resendRequest[1]?.headers).get("Idempotency-Key")).toBe(
      "failure:22222222-2222-4222-8222-222222222222:attempt:3",
    );
    const body = String(resendRequest[1]?.body);
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("upload.example");
    expect(body).toContain("[REDACTED_URL]");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "next_attempt_at=lte.now()",
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      delivery_attempts: 1,
      status: "pending",
    });
  });

  it("does not resend a notification already recorded as sent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1", status: "sent" }]), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a failed deduplicated event with the same Resend idempotency key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1", status: "failed" }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(true);
    expect(
      new Headers(fetcher.mock.calls[3]?.[1]?.headers).get("Idempotency-Key"),
    ).toBe("failure:22222222-2222-4222-8222-222222222222:attempt:3");
  });

  it("does not send when another reconciler already leased the event", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1", status: "failed" }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.some(
        ([url]) => String(url) === "https://api.resend.com/emails",
      ),
    ).toBe(false);
  });

  it("records an uncertain network delivery for scheduled reconciliation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1", status: "pending" }]), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(sendFailureEmailOnce(env, input)).resolves.toBe(false);
    const updateBody = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(updateBody).toMatchObject({ status: "failed" });
  });

  it("reconciles pending events from authoritative target state", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "event-1",
              status: "pending",
              deduplication_key:
                "failure:22222222-2222-4222-8222-222222222222:attempt:3",
              event_type: "target_needs_review",
              post_targets: {
                id: input.targetId,
                owner_id: input.ownerId,
                platform: input.platform,
                scheduled_at_utc: input.scheduledAt,
                last_error_message: input.safeMessage,
                posts: { title: input.postTitle },
              },
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "event-1" }]), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(retryFailedNotifications(env)).resolves.toEqual({
      attempted: 1,
      sent: 1,
    });
  });
});
