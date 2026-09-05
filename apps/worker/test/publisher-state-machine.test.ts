import type { PlatformAdapter } from "@scheduler/platforms";
import { describe, expect, it, vi } from "vitest";

import type { SupabaseRest } from "../src/database";
import type { Env, QueueJob } from "../src/env";
import {
  processClaimedQueueJob,
  processQueueJob,
  type TargetRecord,
} from "../src/publisher";
import { QueueInfrastructureError } from "../src/queue-errors";

const job: QueueJob = {
  targetId: "22222222-2222-4222-8222-222222222222",
  mode: "publish",
  requestedAt: "2026-09-05T01:00:00.000Z",
};

const env = { LIVE_TEST_CONFIRM: "true" } as Env;

function target(overrides: Partial<TargetRecord> = {}): TargetRecord {
  return {
    id: job.targetId,
    owner_id: "11111111-1111-4111-8111-111111111111",
    post_id: "33333333-3333-4333-8333-333333333333",
    platform: "tiktok",
    status: "queued",
    metadata: {} as TargetRecord["metadata"],
    selected_media_ids: [],
    scheduled_at_utc: "2026-09-05T02:00:00.000Z",
    idempotency_key: "publish-once",
    connected_accounts: {
      connection_status: "connected",
      remote_account_id: "creator-1",
      username: "owner",
    },
    posts: { title: "Post", post_media: [] },
    ...overrides,
  };
}

class FakeDatabase {
  readonly updates: Array<{ path: string; body: Record<string, unknown> }> = [];
  failUpdate?: (path: string, body: Record<string, unknown>) => boolean;
  claimResult: Array<{ id: string }> = [{ id: job.targetId }];

  async update<T = unknown>(path: string, body: Record<string, unknown>) {
    this.updates.push({ path, body });
    if (this.failUpdate?.(path, body)) throw new Error("database unavailable");
    if (path.includes("status=in.")) return this.claimResult as T;
    return [] as T;
  }
}

function adapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platform: "tiktok",
    getAuthorizationUrl: vi.fn(),
    exchangeAuthorizationCode: vi.fn(),
    refreshAccessToken: vi.fn(),
    disconnect: vi.fn(),
    getAccountProfile: vi.fn(),
    getCapabilities: vi.fn(),
    validatePost: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
    publish: vi.fn(async () => ({
      outcome: "published",
      sanitizedResponse: {},
    })),
    getPublishStatus: vi.fn(async (_token, statusHandle) => ({
      outcome: "processing",
      statusHandle,
      sanitizedResponse: {},
    })),
    fetchAnalytics: vi.fn(),
    normalizeError: vi.fn((error: unknown) => {
      const value = error as Record<string, unknown>;
      return {
        code: String(value.code ?? "provider_error"),
        message: "Provider request failed",
        retryable: Boolean(value.retryable),
        ambiguous: Boolean(value.ambiguous),
        ...(typeof value.status === "number"
          ? { httpStatus: value.status }
          : {}),
      };
    }),
    ...overrides,
  } as PlatformAdapter;
}

function dependencies(platformAdapter: PlatformAdapter) {
  return {
    adapterFor: vi.fn(() => platformAdapter),
    loadAccessToken: vi.fn(async () => "access-token"),
    nextAttempt: vi.fn(async () => ({ id: "attempt-1", number: 1 })),
    recordFinal: vi.fn(async () => undefined),
    signedDeliveryUrl: vi.fn(async () => "https://delivery.test/media"),
    enqueueQueueJob: vi.fn(async () => undefined),
    encryptSecret: vi.fn(async () => ({
      ciphertext: "encrypted-url",
      nonce: "nonce",
      algorithm: "AES-GCM" as const,
      keyVersion: "v1",
    })),
    now: vi.fn(() => "2026-09-05T01:02:03.000Z"),
  };
}

describe("publish queue operation-aware state machine", () => {
  it.each([
    ["timeout", { code: "network_error", retryable: true, ambiguous: false }],
    ["5xx", { status: 503, retryable: true, ambiguous: false }],
  ])(
    "retries a preflight %s without writing the publish marker",
    async (_case, error) => {
      const publish = vi.fn();
      const platformAdapter = adapter({
        preflightPublish: vi.fn(async () => {
          throw error;
        }),
        publish,
      });
      const deps = dependencies(platformAdapter);
      const db = new FakeDatabase();

      await expect(
        processClaimedQueueJob(
          env,
          db as unknown as SupabaseRest,
          job,
          target(),
          deps,
        ),
      ).rejects.toBeInstanceOf(QueueInfrastructureError);
      expect(publish).not.toHaveBeenCalled();
      expect(
        db.updates.some(({ body }) => "publish_request_sent_at" in body),
      ).toBe(false);
    },
  );

  it.each([
    ["timeout", { code: "network_error", retryable: false, ambiguous: true }],
    ["5xx", { status: 503, retryable: false, ambiguous: true }],
  ])(
    "moves an uncertain publish-init %s to needs_review",
    async (_case, error) => {
      const platformAdapter = adapter({
        publish: vi.fn(async () => {
          throw error;
        }),
      });
      const deps = dependencies(platformAdapter);
      const db = new FakeDatabase();

      await expect(
        processClaimedQueueJob(
          env,
          db as unknown as SupabaseRest,
          job,
          target(),
          deps,
        ),
      ).resolves.toMatchObject({
        classification: "ambiguous_provider_acceptance",
        state: "needs_review",
      });
      expect(deps.recordFinal).toHaveBeenCalledWith(
        env,
        db,
        target(),
        { id: "attempt-1", number: 1 },
        expect.objectContaining({ outcome: "ambiguous" }),
        "2026-09-05T01:02:03.000Z",
      );
      expect(
        db.updates.some(({ body }) => "publish_request_sent_at" in body),
      ).toBe(true);
    },
  );

  it("writes the marker after preflight and immediately before publish initiation", async () => {
    const order: string[] = [];
    const platformAdapter = adapter({
      preflightPublish: vi.fn(async () => {
        order.push("preflight");
        return null;
      }),
      publish: vi.fn(async () => {
        order.push("publish");
        return {
          outcome: "processing",
          statusHandle: "provider-handle",
          sanitizedResponse: {},
        };
      }),
    });
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();
    const originalUpdate = db.update.bind(db);
    db.update = async <T>(path: string, body: Record<string, unknown>) => {
      if ("publish_request_sent_at" in body) order.push("marker");
      return originalUpdate<T>(path, body);
    };

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        job,
        target(),
        deps,
      ),
    ).resolves.toMatchObject({ state: "processing" });
    expect(order).toEqual(["preflight", "marker", "publish"]);
    expect(db.updates).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          status: "processing",
          platform_upload_state: expect.objectContaining({
            statusHandle: "provider-handle",
          }),
        }),
      }),
    );
  });

  it("reconciles an ambiguous response when the provider supplied a status handle", async () => {
    const platformAdapter = adapter({
      publish: vi.fn(async () => {
        throw {
          code: "invalid_upload_session",
          retryable: false,
          ambiguous: true,
          statusHandle: "provider-handle",
        };
      }),
    });
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        job,
        target(),
        deps,
      ),
    ).resolves.toMatchObject({
      classification: "safe_continuation",
      state: "processing",
    });
    expect(db.updates).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          platform_upload_state: expect.objectContaining({
            statusHandle: "provider-handle",
          }),
        }),
      }),
    );
    expect(deps.recordFinal).not.toHaveBeenCalled();
  });

  it("never republishes a redelivery after publish_request_sent_at", async () => {
    const publish = vi.fn();
    const platformAdapter = adapter({ publish });
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        job,
        target({
          status: "publishing",
          publish_request_sent_at: "2026-09-05T01:02:03.000Z",
          platform_upload_state: {
            phase: "request_sent",
            attemptId: "attempt-1",
            attemptNumber: 1,
          },
        }),
        deps,
      ),
    ).resolves.toMatchObject({
      classification: "ambiguous_provider_acceptance",
      state: "needs_review",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(deps.nextAttempt).not.toHaveBeenCalled();
    expect(deps.recordFinal).toHaveBeenCalledWith(
      env,
      db,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outcome: "ambiguous" }),
      "2026-09-05T01:02:03.000Z",
    );
  });

  it("does not call the provider when the marker database write fails", async () => {
    const publish = vi.fn();
    const platformAdapter = adapter({ publish });
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();
    db.failUpdate = (_path, body) => "publish_request_sent_at" in body;

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        job,
        target(),
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(publish).not.toHaveBeenCalled();
  });

  it("persists an acceptance handle before later database failure and reconciles redelivery", async () => {
    const publish = vi.fn(async () => ({
      outcome: "processing" as const,
      statusHandle: "provider-handle",
      sanitizedResponse: {},
    }));
    const getPublishStatus = vi.fn(async () => ({
      outcome: "published" as const,
      remoteContentId: "remote-1",
      sanitizedResponse: {},
    }));
    const platformAdapter = adapter({ publish, getPublishStatus });
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();
    let persistedState: Record<string, unknown> | undefined;
    db.failUpdate = (path, body) => {
      if (path.startsWith("post_targets") && body.status === "processing") {
        persistedState = body.platform_upload_state as Record<string, unknown>;
      }
      return path.startsWith("publish_attempts");
    };

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        job,
        target(),
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(persistedState).toMatchObject({ statusHandle: "provider-handle" });

    db.failUpdate = undefined;
    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        { ...job, mode: "poll" },
        target({
          status: "processing",
          publish_request_sent_at: "2026-09-05T01:02:03.000Z",
          platform_upload_state: persistedState,
        }),
        deps,
      ),
    ).resolves.toMatchObject({ classification: "success" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(getPublishStatus).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "429", "5xx"])(
    "safely retries read-only polling after %s",
    async (failure) => {
      const platformAdapter = adapter({
        getPublishStatus: vi.fn(async () => {
          throw {
            code: `poll_${failure}`,
            status:
              failure === "429" ? 429 : failure === "5xx" ? 503 : undefined,
            retryable: true,
            ambiguous: false,
          };
        }),
      });
      const deps = dependencies(platformAdapter);
      const db = new FakeDatabase();

      await expect(
        processClaimedQueueJob(
          env,
          db as unknown as SupabaseRest,
          { ...job, mode: "poll" },
          target({
            status: "processing",
            publish_request_sent_at: "2026-09-05T01:02:03.000Z",
            platform_upload_state: {
              statusHandle: "provider-handle",
              attemptId: "attempt-1",
              attemptNumber: 1,
            },
          }),
          deps,
        ),
      ).resolves.toMatchObject({
        classification: "safe_continuation",
        state: "processing",
      });
      expect(deps.enqueueQueueJob).toHaveBeenCalledTimes(1);
      expect(deps.recordFinal).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "terminal failure",
      async () => ({
        outcome: "failed" as const,
        sanitizedResponse: {},
        error: { code: "rejected", message: "Rejected", retryable: false },
      }),
      "definite_provider_rejection",
      "failed",
    ],
    [
      "ambiguous side effect",
      async () => {
        throw { code: "network_error", retryable: false, ambiguous: true };
      },
      "ambiguous_provider_acceptance",
      "needs_review",
    ],
  ] as const)(
    "records polling %s",
    async (_case, getPublishStatus, classification, state) => {
      const platformAdapter = adapter({
        getPublishStatus: vi.fn(getPublishStatus),
      });
      const deps = dependencies(platformAdapter);
      const db = new FakeDatabase();

      await expect(
        processClaimedQueueJob(
          env,
          db as unknown as SupabaseRest,
          { ...job, mode: "poll" },
          target({
            status: "processing",
            publish_request_sent_at: "2026-09-05T01:02:03.000Z",
            platform_upload_state: {
              statusHandle: "provider-handle",
              attemptId: "attempt-1",
              attemptNumber: 1,
            },
          }),
          deps,
        ),
      ).resolves.toMatchObject({ classification, state });
    },
  );

  it("releases the queue lease after an enqueue failure", async () => {
    const db = new FakeDatabase();
    const platformAdapter = adapter({
      publish: vi.fn(async () => ({
        outcome: "processing",
        statusHandle: "provider-handle",
        sanitizedResponse: {},
      })),
    });
    const deps = dependencies(platformAdapter);
    deps.enqueueQueueJob.mockRejectedValueOnce(
      new QueueInfrastructureError(job),
    );

    await expect(
      processQueueJob(env, job, {
        createDatabase: () => db as unknown as SupabaseRest,
        loadTarget: vi.fn(async () => target()),
        processClaimedQueueJob: (
          environment,
          database,
          queueJob,
          queueTarget,
        ) =>
          processClaimedQueueJob(
            environment,
            database,
            queueJob,
            queueTarget,
            deps,
          ),
        leaseOwner: () => "queue:test",
      }),
    ).rejects.toBeInstanceOf(QueueInfrastructureError);
    expect(db.updates.at(-1)).toMatchObject({
      path: expect.stringContaining("lease_owner=eq.queue%3Atest"),
      body: { lease_owner: null, lease_expires_at: null },
    });
    expect(platformAdapter.publish).toHaveBeenCalledTimes(1);
  });
});

describe("Instagram durable provider-write phases", () => {
  const baseState = {
    statusHandle: "instagram-status-handle",
    attemptId: "attempt-1",
    attemptNumber: 1,
  };

  function instagramTarget(
    platformState: Record<string, unknown> = baseState,
  ): TargetRecord {
    return target({
      platform: "instagram",
      status: "processing",
      publish_request_sent_at: "2026-09-05T01:02:03.000Z",
      platform_upload_state: platformState,
    });
  }

  function instagramAdapter(
    phase: string,
    executePublishWrite: PlatformAdapter["executePublishWrite"],
  ): PlatformAdapter {
    return adapter({
      platform: "instagram",
      getPublishStatus: vi.fn(async (_token, statusHandle) => ({
        outcome: "processing",
        statusHandle,
        nextProviderWrite: { phase },
        sanitizedResponse: {},
      })),
      executePublishWrite,
    });
  }

  it("does not repeat accepted carousel parent creation when handle persistence fails", async () => {
    const executePublishWrite = vi.fn(async () => ({
      outcome: "processing" as const,
      statusHandle: "instagram-parent-handle",
      sanitizedResponse: { creationId: "parent-1" },
    }));
    const platformAdapter = instagramAdapter(
      "instagram_carousel_parent",
      executePublishWrite,
    );
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();
    let writeAheadState: Record<string, unknown> | undefined;
    db.failUpdate = (_path, body) => {
      const state = body.platform_upload_state as
        Record<string, unknown> | undefined;
      if (state?.providerWrite) writeAheadState = state;
      return Boolean(state?.lastProviderWrite);
    };

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        { ...job, mode: "poll" },
        instagramTarget(),
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(executePublishWrite).toHaveBeenCalledTimes(1);
    expect(writeAheadState).toMatchObject({
      providerWrite: { phase: "instagram_carousel_parent" },
    });

    db.failUpdate = undefined;
    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        { ...job, mode: "poll" },
        instagramTarget(writeAheadState),
        deps,
      ),
    ).resolves.toMatchObject({
      classification: "ambiguous_provider_acceptance",
      state: "needs_review",
    });
    expect(executePublishWrite).toHaveBeenCalledTimes(1);
  });

  it("does not repeat accepted media_publish when final persistence fails", async () => {
    const executePublishWrite = vi.fn(async () => ({
      outcome: "published" as const,
      remoteContentId: "instagram-media-1",
      sanitizedResponse: { id: "instagram-media-1" },
    }));
    const platformAdapter = instagramAdapter(
      "instagram_media_publish",
      executePublishWrite,
    );
    const deps = dependencies(platformAdapter);
    deps.recordFinal.mockRejectedValueOnce(new Error("database unavailable"));
    const db = new FakeDatabase();

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        { ...job, mode: "poll" },
        instagramTarget(),
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    const writeAheadState = db.updates.find(({ body }) =>
      Boolean(
        (body.platform_upload_state as Record<string, unknown> | undefined)
          ?.providerWrite,
      ),
    )?.body.platform_upload_state as Record<string, unknown>;

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        { ...job, mode: "poll" },
        instagramTarget(writeAheadState),
        deps,
      ),
    ).resolves.toMatchObject({
      classification: "ambiguous_provider_acceptance",
      state: "needs_review",
    });
    expect(executePublishWrite).toHaveBeenCalledTimes(1);
    expect(deps.recordFinal).toHaveBeenLastCalledWith(
      env,
      db,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outcome: "ambiguous" }),
      "2026-09-05T01:02:03.000Z",
    );
  });

  it.each([
    ["carousel parent timeout", "instagram_carousel_parent", "network_error"],
    ["carousel parent 5xx", "instagram_carousel_parent", "meta_503"],
    ["media_publish timeout", "instagram_media_publish", "network_error"],
    ["media_publish 5xx", "instagram_media_publish", "meta_503"],
  ])("fails closed after %s", async (_case, phase, code) => {
    const executePublishWrite = vi.fn(async () => {
      throw {
        code,
        status: code === "meta_503" ? 503 : undefined,
        retryable: false,
        ambiguous: true,
      };
    });
    const platformAdapter = instagramAdapter(phase, executePublishWrite);
    const deps = dependencies(platformAdapter);
    const db = new FakeDatabase();

    await expect(
      processClaimedQueueJob(
        env,
        db as unknown as SupabaseRest,
        { ...job, mode: "poll" },
        instagramTarget(),
        deps,
      ),
    ).resolves.toMatchObject({
      classification: "ambiguous_provider_acceptance",
      state: "needs_review",
    });
    expect(executePublishWrite).toHaveBeenCalledTimes(1);
    expect(deps.recordFinal).toHaveBeenCalledWith(
      env,
      db,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ outcome: "ambiguous" }),
      "2026-09-05T01:02:03.000Z",
    );
  });

  it.each([
    "instagram_child_container",
    "instagram_carousel_parent",
    "instagram_media_publish",
  ])(
    "never executes a second %s write after redelivery finds its marker",
    async (phase) => {
      const executePublishWrite = vi.fn();
      const platformAdapter = instagramAdapter(phase, executePublishWrite);
      const deps = dependencies(platformAdapter);
      const db = new FakeDatabase();

      await expect(
        processClaimedQueueJob(
          env,
          db as unknown as SupabaseRest,
          { ...job, mode: "poll" },
          instagramTarget({
            ...baseState,
            providerWrite: {
              phase,
              requestSentAt: "2026-09-05T01:03:00.000Z",
            },
          }),
          deps,
        ),
      ).resolves.toMatchObject({
        classification: "ambiguous_provider_acceptance",
        state: "needs_review",
      });
      expect(platformAdapter.getPublishStatus).not.toHaveBeenCalled();
      expect(executePublishWrite).not.toHaveBeenCalled();
    },
  );
});
