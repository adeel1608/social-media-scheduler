import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, QueueJob } from "../src/env";
import {
  handleQueueMessage,
  QUEUE_MAX_DELIVERY_ATTEMPTS,
  QUEUE_MAX_RETRIES,
} from "../src/queue-handler";
import {
  classifyPublishResult,
  QueueInfrastructureError,
  type QueueProcessResult,
} from "../src/queue-errors";
import { recoveryModeForTarget } from "../src/queue-recovery";

const job: QueueJob = {
  targetId: "22222222-2222-4222-8222-222222222222",
  mode: "publish",
  requestedAt: "2026-09-05T00:00:00.000Z",
};

function message(attempts = 1) {
  return {
    id: "queue-message-1",
    attempts,
    body: job,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("queue acknowledgement classification", () => {
  it.each<QueueProcessResult>([
    { classification: "success", provider: "tiktok", state: "published" },
    {
      classification: "validation_or_authorization_failure",
      provider: "tiktok",
      state: "failed",
    },
    {
      classification: "definite_provider_rejection",
      provider: "tiktok",
      state: "failed",
    },
    {
      classification: "ambiguous_provider_acceptance",
      provider: "tiktok",
      state: "needs_review",
    },
    {
      classification: "duplicate_delivery",
      provider: "tiktok",
      state: "published",
    },
  ])(
    "acknowledges durable application result: $classification",
    async (result) => {
      const delivery = message();
      const processor = vi.fn().mockResolvedValue(result);

      await expect(
        handleQueueMessage({} as Env, delivery, processor),
      ).resolves.toEqual({ action: "ack", result });
      expect(delivery.ack).toHaveBeenCalledOnce();
      expect(delivery.retry).not.toHaveBeenCalled();
    },
  );

  it("retries a database or network infrastructure failure without acknowledging", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const delivery = message(2);
    const processor = vi
      .fn()
      .mockRejectedValue(
        new QueueInfrastructureError(job, "tiktok", "publishing"),
      );

    await expect(
      handleQueueMessage({} as Env, delivery, processor),
    ).resolves.toEqual({ action: "retry" });
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(delivery.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    const output = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      message: "queue_job_retrying",
      targetId: job.targetId,
      messageId: "queue-message-1",
      attempt: 2,
      provider: "tiktok",
      state: "publishing",
      classification: "retryable_infrastructure",
    });
  });

  it("leaves an exhausted failure unacknowledged for configured DLQ transfer", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const delivery = message(QUEUE_MAX_DELIVERY_ATTEMPTS);
    const processor = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));

    await expect(
      handleQueueMessage({} as Env, delivery, processor),
    ).resolves.toEqual({ action: "dlq" });
    expect(delivery.ack).not.toHaveBeenCalled();
    expect(delivery.retry).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("queue_retry_exhausted");
  });

  it("maps provider results without making ambiguous outcomes retryable", () => {
    expect(
      classifyPublishResult({
        outcome: "failed",
        sanitizedResponse: {},
      }),
    ).toBe("definite_provider_rejection");
    expect(
      classifyPublishResult({
        outcome: "ambiguous",
        sanitizedResponse: {},
      }),
    ).toBe("ambiguous_provider_acceptance");
  });
});

describe("stale publishing recovery", () => {
  it("continues existing upload sessions, polls provider handles, and never resubmits blindly", () => {
    expect(
      recoveryModeForTarget({
        status: "processing",
        platform_upload_state: {
          encryptedUrl: "encrypted-session",
          uploadComplete: false,
        },
      }),
    ).toBe("upload");
    expect(
      recoveryModeForTarget({
        status: "processing",
        platform_upload_state: { statusHandle: "provider-job" },
      }),
    ).toBe("poll");
    expect(
      recoveryModeForTarget({
        status: "publishing",
        platform_upload_state: null,
      }),
    ).toBe("publish");
  });

  it("keeps retry and DLQ configuration aligned with the handler", () => {
    const config = readFileSync(
      resolve(process.cwd(), "apps/worker/wrangler.toml"),
      "utf8",
    );
    expect(QUEUE_MAX_RETRIES).toBe(5);
    expect(config).toMatch(/max_retries\s*=\s*5/);
    expect(config).toMatch(
      /dead_letter_queue\s*=\s*"social-scheduler-dead-letter"/,
    );
  });
});
