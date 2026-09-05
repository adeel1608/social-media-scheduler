import {
  decryptSecret,
  encryptSecret,
  redactSecrets,
  SecretDecryptionError,
  youTubeMetadataSchema,
  type Platform,
  type PlatformMetadata,
  type PublishResult,
} from "@scheduler/shared";
import {
  providerHttpError,
  providerRequest,
  trustedUploadSessionUrl,
  type PlatformAdapter,
  type PublishInput,
} from "@scheduler/platforms";

import { adapterFor } from "./adapters";
import { DatabaseRequestError, SupabaseRest } from "./database";
import { encryptionKeyResolver } from "./encryption";
import type { Env, QueueJob } from "./env";
import { logWorkerError } from "./logging";
import { sendFailureEmailOnce } from "./notifications";
import {
  classifyPublishResult,
  QueueInfrastructureError,
  type QueueProcessResult,
  type QueueProcessingClassification,
} from "./queue-errors";
import { recoveryModeForTarget } from "./queue-recovery";
import {
  fetchMediaBody,
  fetchMediaRange,
  MediaStorageError,
  signedDeliveryUrl,
} from "./storage";

export interface TargetRecord {
  id: string;
  owner_id: string;
  post_id: string;
  platform: Platform;
  status: string;
  metadata: PlatformMetadata;
  selected_media_ids: string[];
  scheduled_at_utc: string;
  idempotency_key: string;
  publish_request_sent_at?: string;
  remote_content_id?: string;
  platform_upload_state?: Record<string, any>;
  connected_accounts: Record<string, any>;
  posts: {
    title: string;
    post_media: Array<{
      sort_order: number;
      media_assets: {
        id: string;
        object_key: string;
        storage_provider: string;
        provider_file_key: string | null;
        provider_url: string | null;
        mime_type: string;
        size_bytes: number;
        upload_status: string;
        deleted_at: string | null;
        width?: number;
        height?: number;
        duration_seconds?: number;
      };
    }>;
  };
}

function queueResult(
  target: Pick<TargetRecord, "platform" | "status">,
  classification: QueueProcessingClassification,
  state = target.status,
): QueueProcessResult {
  return { classification, provider: target.platform, state };
}

function isInfrastructureError(error: unknown): boolean {
  return (
    error instanceof DatabaseRequestError ||
    error instanceof MediaStorageError ||
    error instanceof QueueInfrastructureError
  );
}

async function enqueueQueueJob(
  env: Env,
  job: QueueJob,
  delaySeconds?: number,
): Promise<void> {
  try {
    await env.PUBLISH_QUEUE.send(
      job,
      delaySeconds === undefined ? undefined : { delaySeconds },
    );
  } catch {
    throw new QueueInfrastructureError(job);
  }
}

interface ClaimedQueueJobDependencies {
  adapterFor: (platform: Platform, env: Env) => PlatformAdapter;
  loadAccessToken: typeof loadAccessToken;
  nextAttempt: typeof nextAttempt;
  recordFinal: typeof recordFinal;
  signedDeliveryUrl: typeof signedDeliveryUrl;
  enqueueQueueJob: typeof enqueueQueueJob;
  encryptSecret: typeof encryptSecret;
  now: () => string;
}

function claimedQueueJobDependencies(
  overrides: Partial<ClaimedQueueJobDependencies> = {},
): ClaimedQueueJobDependencies {
  return {
    adapterFor,
    loadAccessToken,
    nextAttempt,
    recordFinal,
    signedDeliveryUrl,
    enqueueQueueJob,
    encryptSecret,
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

interface QueueJobDependencies {
  createDatabase: (env: Env) => SupabaseRest;
  loadTarget: typeof loadTarget;
  processClaimedQueueJob: typeof processClaimedQueueJob;
  enqueueQueueJob: typeof enqueueQueueJob;
  leaseOwner: () => string;
  now: () => Date;
}

export function acceptedUploadByte(
  platform: Platform,
  response: Response,
  requestedEndExclusive: number,
): number {
  if (platform !== "youtube" || response.status !== 308) {
    return requestedEndExclusive;
  }
  const range = response.headers.get("Range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const nextByte = match ? Number(match[1]) + 1 : Number.NaN;
  if (
    !Number.isSafeInteger(nextByte) ||
    nextByte < 0 ||
    nextByte > requestedEndExclusive
  ) {
    throw new Error("Provider returned an invalid resumable upload range");
  }
  return nextByte;
}

async function loadTarget(
  db: SupabaseRest,
  id: string,
): Promise<TargetRecord | null> {
  const rows = await db.select<TargetRecord[]>(
    `post_targets?id=eq.${encodeURIComponent(id)}&select=*,connected_accounts(*),posts(title,post_media(sort_order,media_assets(*)))&limit=1`,
  );
  return rows[0] ?? null;
}

async function loadAccessToken(
  env: Env,
  target: TargetRecord,
): Promise<string> {
  const account = target.connected_accounts;
  if (!account || account.connection_status !== "connected")
    throw new Error("Platform account is not connected");
  const accessToken = await decryptSecret(
    {
      ciphertext: account.encrypted_access_token,
      nonce: account.access_token_nonce,
      algorithm: "AES-GCM",
      keyVersion: account.encryption_key_version,
    },
    encryptionKeyResolver(env),
  );
  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : null;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60 * 1_000) return accessToken;
  const refreshToken =
    account.encrypted_refresh_token && account.refresh_token_nonce
      ? await decryptSecret(
          {
            ciphertext: account.encrypted_refresh_token,
            nonce: account.refresh_token_nonce,
            algorithm: "AES-GCM",
            keyVersion: account.encryption_key_version,
          },
          encryptionKeyResolver(env),
        )
      : undefined;
  const refreshed = await adapterFor(target.platform, env).refreshAccessToken({
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: account.token_expires_at,
    scopes: account.scopes ?? [],
    raw: {},
  });
  const encryptedAccess = await encryptSecret(
    refreshed.accessToken,
    env.TOKEN_ENCRYPTION_KEY,
    env.TOKEN_ENCRYPTION_KEY_VERSION,
  );
  // Keep the account's single key-version column truthful even when a provider
  // rotates only the access token: re-encrypt the existing refresh token under
  // the same current version instead of leaving old ciphertext mislabeled.
  const refreshValue = refreshed.refreshToken ?? refreshToken;
  const encryptedRefresh = refreshValue
    ? await encryptSecret(
        refreshValue,
        env.TOKEN_ENCRYPTION_KEY,
        env.TOKEN_ENCRYPTION_KEY_VERSION,
      )
    : null;
  await new SupabaseRest(env).update(`connected_accounts?id=eq.${account.id}`, {
    encrypted_access_token: encryptedAccess.ciphertext,
    access_token_nonce: encryptedAccess.nonce,
    ...(encryptedRefresh
      ? {
          encrypted_refresh_token: encryptedRefresh.ciphertext,
          refresh_token_nonce: encryptedRefresh.nonce,
        }
      : {
          encrypted_refresh_token: null,
          refresh_token_nonce: null,
        }),
    encryption_key_version: encryptedAccess.keyVersion,
    token_expires_at: refreshed.expiresAt,
    metadata: {
      ...(account.metadata ?? {}),
      ...(typeof refreshed.raw.refreshTokenExpiresAt === "string"
        ? { refreshTokenExpiresAt: refreshed.raw.refreshTokenExpiresAt }
        : {}),
    },
    connection_status: "connected",
    updated_at: new Date().toISOString(),
  });
  return refreshed.accessToken;
}

async function nextAttempt(
  db: SupabaseRest,
  target: TargetRecord,
  manualRetry = false,
) {
  const previous = await db.select<Array<{ attempt_number: number }>>(
    `publish_attempts?post_target_id=eq.${target.id}&select=attempt_number&order=attempt_number.desc&limit=1`,
  );
  const attemptNumber = (previous[0]?.attempt_number ?? 0) + 1;
  const rows = await db.insert<Array<{ id: string }>>("publish_attempts", {
    owner_id: target.owner_id,
    post_target_id: target.id,
    attempt_number: attemptNumber,
    idempotency_key: target.idempotency_key,
    manual_retry: manualRetry,
  });
  return { id: rows[0]!.id, number: attemptNumber };
}

async function recordFinal(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  attempt: { id: string; number: number },
  result: PublishResult,
  requestSentAt?: string,
) {
  const remoteUrl =
    result.remoteUrl ??
    (result.remoteContentId &&
    target.platform === "tiktok" &&
    target.connected_accounts.username
      ? `https://www.tiktok.com/@${encodeURIComponent(target.connected_accounts.username ?? "")}/video/${encodeURIComponent(result.remoteContentId)}`
      : undefined);
  const status =
    result.outcome === "ambiguous" ? "needs_review" : result.outcome;
  await db.update(`post_targets?id=eq.${target.id}`, {
    status,
    ...(result.remoteContentId
      ? { remote_content_id: result.remoteContentId }
      : {}),
    ...(remoteUrl ? { remote_url: remoteUrl } : {}),
    ...(result.error
      ? {
          last_error_code: result.error.code,
          last_error_message: result.error.message,
        }
      : {}),
    ...(result.outcome === "published"
      ? { published_at: new Date().toISOString() }
      : {}),
    lease_owner: null,
    lease_expires_at: null,
    updated_at: new Date().toISOString(),
  });
  await db.update(`publish_attempts?id=eq.${attempt.id}`, {
    ...(requestSentAt ? { request_sent_at: requestSentAt } : {}),
    finished_at: new Date().toISOString(),
    outcome: result.outcome,
    ...(result.error
      ? {
          safe_error_code: result.error.code,
          safe_error_message: result.error.message,
        }
      : {}),
    sanitized_response: redactSecrets(result.sanitizedResponse),
  });
  try {
    await updateMediaRetentionForPost(db, target.post_id);
  } catch {
    logWorkerError("media_retention_update_failed", { targetId: target.id });
  }
  if (status === "failed" || status === "needs_review") {
    await sendFailureEmailOnce(env, {
      ownerId: target.owner_id,
      targetId: target.id,
      postTitle: target.posts.title,
      platform: target.platform,
      scheduledAt: target.scheduled_at_utc,
      status,
      safeMessage:
        result.error?.message ?? "The platform result could not be confirmed.",
      attempt: attempt.number,
    });
  }
}

export async function updateMediaRetentionForPost(
  db: SupabaseRest,
  postId: string,
) {
  const targets = await db.select<Array<{ status: string }>>(
    `post_targets?post_id=eq.${postId}&select=status`,
  );
  const mediaLinks = await db.select<Array<{ media_asset_id: string }>>(
    `post_media?post_id=eq.${postId}&select=media_asset_id`,
  );
  const mediaIds = mediaLinks.map((item) => item.media_asset_id);
  if (!mediaIds.length || !targets.length) return;
  const filter = `media_assets?id=in.(${mediaIds.join(",")})`;
  if (
    targets.some(({ status }) => ["failed", "needs_review"].includes(status))
  ) {
    await db.update(filter, {
      retain_until: null,
      deletion_blocked_reason: "target_failure_or_ambiguity",
      updated_at: new Date().toISOString(),
    });
    return;
  }
  if (targets.every(({ status }) => status === "published")) {
    await db.update(filter, {
      retain_until: new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1_000,
      ).toISOString(),
      deletion_blocked_reason: null,
      updated_at: new Date().toISOString(),
    });
  }
}

function selectedPublishMedia(target: TargetRecord): PublishInput["media"] {
  const selected = new Set(target.selected_media_ids);
  return [...target.posts.post_media]
    .filter(({ media_assets: item }) => selected.has(item.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(({ media_assets: item }) => ({
      id: item.id,
      objectKey: item.object_key,
      storageProvider: item.storage_provider,
      providerFileKey: item.provider_file_key,
      providerUrl: item.provider_url,
      mimeType: item.mime_type,
      sizeBytes: item.size_bytes,
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.duration_seconds
        ? { durationSeconds: item.duration_seconds }
        : {}),
    }));
}

async function publishInputForTarget(
  env: Env,
  target: TargetRecord,
  accessToken: string,
  dependencies: ClaimedQueueJobDependencies,
): Promise<PublishInput> {
  const media = selectedPublishMedia(target);
  const deliveryUrls = await Promise.all(
    media.map((item) =>
      dependencies.signedDeliveryUrl(env, {
        mediaId: item.id,
        ownerId: target.owner_id,
      }),
    ),
  );
  return {
    accountId: String(target.connected_accounts.remote_account_id),
    accessToken,
    idempotencyKey: target.idempotency_key,
    metadata: target.metadata,
    media,
    deliveryUrls,
  };
}

export async function processQueueJob(
  env: Env,
  job: QueueJob,
  overrides: Partial<QueueJobDependencies> = {},
): Promise<QueueProcessResult> {
  const dependencies: QueueJobDependencies = {
    createDatabase: (environment) => new SupabaseRest(environment),
    loadTarget,
    processClaimedQueueJob,
    enqueueQueueJob,
    leaseOwner: () => `queue:${crypto.randomUUID()}`,
    now: () => new Date(),
    ...overrides,
  };
  const db = dependencies.createDatabase(env);
  const leaseOwner = dependencies.leaseOwner();
  const now = dependencies.now();
  let target: TargetRecord | null = null;
  try {
    const claimed = await db.update<Array<{ id: string }>>(
      `post_targets?id=eq.${encodeURIComponent(job.targetId)}&status=in.(queued,publishing,processing)&or=(lease_expires_at.is.null,lease_expires_at.lte.${encodeURIComponent(now.toISOString())})`,
      {
        lease_owner: leaseOwner,
        lease_expires_at: new Date(
          now.getTime() + 10 * 60 * 1_000,
        ).toISOString(),
      },
    );
    if (!claimed.length) {
      target = await dependencies.loadTarget(db, job.targetId);
      if (
        target &&
        ["queued", "publishing", "processing"].includes(target.status)
      ) {
        await dependencies.enqueueQueueJob(
          env,
          { ...job, requestedAt: new Date().toISOString() },
          30,
        );
      }
      return target
        ? queueResult(target, "duplicate_delivery")
        : { classification: "duplicate_delivery", state: "not_found" };
    }
    target = await dependencies.loadTarget(db, job.targetId);
    if (!target) {
      return { classification: "duplicate_delivery", state: "not_found" };
    }
    return await dependencies.processClaimedQueueJob(env, db, job, target);
  } catch (error) {
    if (error instanceof QueueInfrastructureError) {
      throw new QueueInfrastructureError(
        job,
        error.provider ?? target?.platform,
        error.targetState ?? target?.status,
      );
    }
    throw new QueueInfrastructureError(job, target?.platform, target?.status);
  } finally {
    try {
      await db.update(
        `post_targets?id=eq.${encodeURIComponent(job.targetId)}&lease_owner=eq.${encodeURIComponent(leaseOwner)}`,
        { lease_owner: null, lease_expires_at: null },
      );
    } catch {
      if (target) {
        logWorkerError("queue_lease_release_failed", {
          targetId: target.id,
          provider: target.platform,
          state: target.status,
          classification: "retryable_infrastructure",
        });
      }
    }
  }
}

export async function processClaimedQueueJob(
  env: Env,
  db: SupabaseRest,
  job: QueueJob,
  target: TargetRecord,
  overrides: Partial<ClaimedQueueJobDependencies> = {},
): Promise<QueueProcessResult> {
  const dependencies = claimedQueueJobDependencies(overrides);
  if (
    ["published", "failed", "needs_review", "cancelled"].includes(target.status)
  )
    return queueResult(target, "duplicate_delivery");
  if (env.LIVE_TEST_CONFIRM !== "true") {
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "blocked_authorization",
      last_error_code: "live_test_not_confirmed",
      last_error_message:
        "Set LIVE_TEST_CONFIRM=true only after the owner approves real publishing.",
      lease_owner: null,
      lease_expires_at: null,
    });
    return queueResult(
      target,
      "validation_or_authorization_failure",
      "blocked_authorization",
    );
  }
  const adapter = dependencies.adapterFor(target.platform, env);
  let accessToken: string;
  try {
    accessToken = await dependencies.loadAccessToken(env, target);
  } catch (error) {
    if (
      isInfrastructureError(error) ||
      (error instanceof SecretDecryptionError &&
        error.code === "key_unavailable")
    ) {
      throw error;
    }
    const normalized = adapter.normalizeError(error);
    if (normalized.retryable || normalized.ambiguous) {
      throw new QueueInfrastructureError(job, target.platform, target.status);
    }
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "blocked_authorization",
      last_error_code: "token_refresh_failed",
      last_error_message:
        "The platform token expired and could not be refreshed. Reconnect the account.",
      lease_owner: null,
      lease_expires_at: null,
    });
    return queueResult(
      target,
      "validation_or_authorization_failure",
      "blocked_authorization",
    );
  }
  // Database state is authoritative after redelivery. If dispatching the next
  // mode failed, the Queue retry still contains the previous message body; do
  // not let that stale mode re-initiate a provider request or skip an upload.
  const continuationMode = recoveryModeForTarget(target);
  if (continuationMode === "upload")
    return continueUploadSafely(env, db, target, accessToken, dependencies);
  if (continuationMode === "poll")
    return pollStatus(env, db, target, accessToken, dependencies);

  if (target.publish_request_sent_at) {
    // A publish request might already have reached the platform. Never send another one automatically.
    if (target.platform_upload_state?.statusHandle) {
      await dependencies.enqueueQueueJob(
        env,
        { ...job, mode: "poll", requestedAt: new Date().toISOString() },
        60,
      );
      return queueResult(target, "safe_continuation", "processing");
    } else {
      const state = target.platform_upload_state;
      const attempt =
        typeof state?.attemptId === "string"
          ? {
              id: state.attemptId,
              number: Number(state.attemptNumber ?? 1),
            }
          : await dependencies.nextAttempt(db, target);
      await dependencies.recordFinal(
        env,
        db,
        target,
        attempt,
        {
          outcome: "ambiguous",
          sanitizedResponse: {
            reason: "prior_publish_request_detected_without_status_handle",
          },
          error: {
            code: "ambiguous_prior_request",
            message:
              "A prior publish request may have been accepted. Review the platform before retrying.",
            retryable: false,
          },
        },
        target.publish_request_sent_at,
      );
      return queueResult(
        target,
        "ambiguous_provider_acceptance",
        "needs_review",
      );
    }
  }

  const media = selectedPublishMedia(target);
  const validation = adapter.validatePost(target.metadata, media);
  if (!validation.valid) {
    const attempt = await dependencies.nextAttempt(db, target);
    await dependencies.recordFinal(env, db, target, attempt, {
      outcome: "failed",
      sanitizedResponse: { validation: validation.errors },
      error: {
        code: "validation_failed",
        message: validation.errors.map((issue) => issue.message).join(" "),
        retryable: false,
      },
    });
    return queueResult(target, "validation_or_authorization_failure", "failed");
  }
  const publishInput = await publishInputForTarget(
    env,
    target,
    accessToken,
    dependencies,
  );
  if (adapter.preflightPublish) {
    let preflightResult: PublishResult | null;
    try {
      preflightResult = await adapter.preflightPublish(publishInput);
    } catch (error) {
      const normalized = adapter.normalizeError(error);
      if (normalized.retryable && !normalized.ambiguous) {
        throw new QueueInfrastructureError(job, target.platform, target.status);
      }
      preflightResult = {
        outcome: "failed",
        sanitizedResponse: {
          code: normalized.code,
          httpStatus: normalized.httpStatus,
          phase: "preflight",
        },
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: false,
        },
      };
    }
    if (preflightResult) {
      const attempt = await dependencies.nextAttempt(db, target);
      await dependencies.recordFinal(env, db, target, attempt, preflightResult);
      return queueResult(
        target,
        classifyPublishResult(preflightResult),
        preflightResult.outcome,
      );
    }
  }

  const attempt = await dependencies.nextAttempt(db, target);
  // This durable marker is the last awaited operation before the first
  // non-idempotent provider request. A redelivery must never cross it twice.
  const requestSentAt = dependencies.now();
  await db.update(`post_targets?id=eq.${target.id}`, {
    status: "publishing",
    publish_request_sent_at: requestSentAt,
    platform_upload_state: {
      phase: "request_sent",
      attemptId: attempt.id,
      attemptNumber: attempt.number,
    },
    updated_at: requestSentAt,
  });
  let result: PublishResult;
  try {
    result = await adapter.publish(publishInput);
  } catch (error) {
    const normalized = adapter.normalizeError(error);
    const statusHandle =
      error &&
      typeof error === "object" &&
      typeof (error as { statusHandle?: unknown }).statusHandle === "string" &&
      (error as { statusHandle: string }).statusHandle.length > 0 &&
      (error as { statusHandle: string }).statusHandle.length <= 512
        ? (error as { statusHandle: string }).statusHandle
        : undefined;
    result =
      normalized.ambiguous && statusHandle
        ? {
            outcome: "processing",
            statusHandle,
            sanitizedResponse: {
              code: normalized.code,
              httpStatus: normalized.httpStatus,
              recoveredStatusHandle: true,
            },
          }
        : {
            outcome: normalized.ambiguous ? "ambiguous" : "failed",
            sanitizedResponse: {
              code: normalized.code,
              httpStatus: normalized.httpStatus,
            },
            error: {
              code: normalized.code,
              message: normalized.message,
              retryable: false,
            },
          };
  }
  if (result.uploadSession) {
    const encrypted = await dependencies.encryptSecret(
      result.uploadSession.url,
      env.TOKEN_ENCRYPTION_KEY,
      env.TOKEN_ENCRYPTION_KEY_VERSION,
    );
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "processing",
      platform_upload_state: {
        encryptedUrl: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyVersion: encrypted.keyVersion,
        nextByte: result.uploadSession.nextByte,
        totalBytes: result.uploadSession.totalBytes,
        chunkSize: result.uploadSession.chunkSize,
        statusHandle: result.statusHandle,
        attemptId: attempt.id,
        attemptNumber: attempt.number,
      },
    });
    await db.update(`publish_attempts?id=eq.${attempt.id}`, {
      request_sent_at: requestSentAt,
      sanitized_response: redactSecrets(result.sanitizedResponse),
    });
    await dependencies.enqueueQueueJob(
      env,
      {
        targetId: target.id,
        mode: "upload",
        requestedAt: new Date().toISOString(),
      },
      1,
    );
    return queueResult(target, "safe_continuation", "processing");
  }
  if (result.outcome === "processing") {
    if (!result.statusHandle) {
      await dependencies.recordFinal(
        env,
        db,
        target,
        attempt,
        {
          outcome: "ambiguous",
          sanitizedResponse: {
            ...result.sanitizedResponse,
            reason: "provider_acceptance_missing_status_handle",
          },
          error: {
            code: "missing_status_handle",
            message:
              "The provider accepted the request without a status identifier. Review the platform before retrying.",
            retryable: false,
          },
        },
        requestSentAt,
      );
      return queueResult(
        target,
        "ambiguous_provider_acceptance",
        "needs_review",
      );
    }
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "processing",
      platform_upload_state: {
        statusHandle: result.statusHandle,
        attemptId: attempt.id,
        attemptNumber: attempt.number,
      },
    });
    await db.update(`publish_attempts?id=eq.${attempt.id}`, {
      request_sent_at: requestSentAt,
      sanitized_response: redactSecrets(result.sanitizedResponse),
    });
    await dependencies.enqueueQueueJob(
      env,
      {
        targetId: target.id,
        mode: "poll",
        requestedAt: new Date().toISOString(),
      },
      60,
    );
    return queueResult(target, "safe_continuation", "processing");
  }
  await dependencies.recordFinal(
    env,
    db,
    target,
    attempt,
    result,
    requestSentAt,
  );
  return queueResult(
    target,
    classifyPublishResult(result),
    result.outcome === "ambiguous" ? "needs_review" : result.outcome,
  );
}

async function continueUploadSafely(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
  dependencies = claimedQueueJobDependencies(),
): Promise<QueueProcessResult> {
  try {
    await continueUpload(env, db, target, accessToken, dependencies);
    return queueResult(target, "safe_continuation", "processing");
  } catch (error) {
    if (isInfrastructureError(error)) throw error;
    const state = target.platform_upload_state;
    if (!state?.attemptId) throw error;
    const normalized = dependencies
      .adapterFor(target.platform, env)
      .normalizeError(error);
    const nextByte = Number(state.nextByte ?? 0);
    const chunkEnd = Math.min(
      nextByte + Number(state.chunkSize ?? 0),
      Number(state.totalBytes ?? 0),
    );
    const fixedRangeCanContinue = chunkEnd < Number(state.totalBytes ?? 0);
    const uploadRetryCount = Number(state.uploadRetryCount ?? 0) + 1;
    if (
      uploadRetryCount <= 5 &&
      (normalized.retryable || (normalized.ambiguous && fixedRangeCanContinue))
    ) {
      // Replaying a fixed byte range in the same resumable session cannot create a second post.
      await db.update(`post_targets?id=eq.${target.id}`, {
        platform_upload_state: { ...state, uploadRetryCount },
      });
      await dependencies.enqueueQueueJob(
        env,
        {
          targetId: target.id,
          mode: "upload",
          requestedAt: new Date().toISOString(),
        },
        Math.min(30 * 2 ** uploadRetryCount, 900),
      );
      return queueResult(target, "safe_continuation", "processing");
    }
    if (normalized.ambiguous && state.statusHandle) {
      // The last chunk may have completed. Reconcile the existing provider job; never re-initiate it.
      await db.update(`post_targets?id=eq.${target.id}`, {
        status: "processing",
        platform_upload_state: { ...state, uploadComplete: "uncertain" },
      });
      await dependencies.enqueueQueueJob(
        env,
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        120,
      );
      return queueResult(target, "ambiguous_provider_acceptance", "processing");
    }
    await dependencies.recordFinal(
      env,
      db,
      target,
      {
        id: state.attemptId as string,
        number: Number(state.attemptNumber ?? 1),
      },
      {
        outcome: normalized.ambiguous ? "ambiguous" : "failed",
        sanitizedResponse: {
          code: normalized.code,
          httpStatus: normalized.httpStatus,
          phase: "resumable_upload",
        },
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: false,
        },
      },
      target.publish_request_sent_at,
    );
    return queueResult(
      target,
      normalized.ambiguous
        ? "ambiguous_provider_acceptance"
        : "definite_provider_rejection",
      normalized.ambiguous ? "needs_review" : "failed",
    );
  }
}

async function continueUpload(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
  dependencies = claimedQueueJobDependencies(),
) {
  const state = target.platform_upload_state;
  if (!state?.encryptedUrl || !state.nonce)
    throw new Error("Upload session state is missing");
  const selected = new Set(target.selected_media_ids);
  const selectedMedia = [...target.posts.post_media]
    .filter(({ media_assets: item }) => selected.has(item.id))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((item) => item.media_assets);
  const media =
    target.platform === "youtube"
      ? selectedMedia.find(
          (item) =>
            item.mime_type.startsWith("video/") ||
            item.mime_type === "application/octet-stream",
        )
      : selectedMedia[0];
  if (!media) throw new Error("Source media is missing");
  const url = await decryptSecret(
    {
      ciphertext: state.encryptedUrl,
      nonce: state.nonce,
      algorithm: "AES-GCM",
      keyVersion: state.keyVersion,
    },
    encryptionKeyResolver(env),
  );
  const trustedUrl = trustedUploadSessionUrl(target.platform, url);
  const start = Number(state.nextByte);
  const endExclusive = Math.min(
    start + Number(state.chunkSize),
    Number(state.totalBytes),
  );
  const sourceBody = await fetchMediaRange(
    env,
    {
      ...media,
      owner_id: target.owner_id,
    },
    start,
    endExclusive,
  );
  const response = await providerRequest(
    fetch,
    trustedUrl,
    {
      operation: "idempotent",
      method: "PUT",
      redirect: "manual",
      headers: {
        ...(target.platform === "youtube"
          ? { Authorization: `Bearer ${accessToken}` }
          : {}),
        "Content-Type": media.mime_type,
        "Content-Length": String(endExclusive - start),
        "Content-Range": `bytes ${start}-${endExclusive - 1}/${state.totalBytes}`,
      },
      body: sourceBody,
    },
    120_000,
  );
  const accepted =
    response.ok || (target.platform === "youtube" && response.status === 308);
  if (!accepted)
    throw providerHttpError(
      response.status,
      { message: (await response.text()).slice(0, 500) },
      "idempotent",
    );
  const nextByte = acceptedUploadByte(target.platform, response, endExclusive);
  if (nextByte === start) {
    throw providerHttpError(
      503,
      { message: "Resumable upload made no progress" },
      "idempotent",
    );
  }
  if (nextByte < Number(state.totalBytes)) {
    await db.update(`post_targets?id=eq.${target.id}`, {
      platform_upload_state: { ...state, nextByte, uploadRetryCount: 0 },
    });
    await dependencies.enqueueQueueJob(
      env,
      {
        targetId: target.id,
        mode: "upload",
        requestedAt: new Date().toISOString(),
      },
      1,
    );
    return;
  }
  let statusHandle = state.statusHandle as string | undefined;
  if (target.platform === "youtube" && response.ok) {
    const completed = (await response.json().catch(() => null)) as {
      id?: string;
    } | null;
    statusHandle = completed?.id;
  }
  await db.update(`post_targets?id=eq.${target.id}`, {
    status: "processing",
    platform_upload_state: {
      statusHandle,
      attemptId: state.attemptId,
      attemptNumber: state.attemptNumber,
      uploadComplete: true,
    },
  });
  await dependencies.enqueueQueueJob(
    env,
    {
      targetId: target.id,
      mode: "poll",
      requestedAt: new Date().toISOString(),
    },
    60,
  );
}

export async function pollStatus(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
  dependencies = claimedQueueJobDependencies(),
): Promise<QueueProcessResult> {
  const state = target.platform_upload_state;
  if (!state?.attemptId) throw new Error("Publish attempt state is missing");
  const pendingProviderWrite = state.providerWrite as
    { phase?: unknown; requestSentAt?: unknown } | undefined;
  if (pendingProviderWrite) {
    const phase =
      typeof pendingProviderWrite.phase === "string"
        ? pendingProviderWrite.phase.slice(0, 100)
        : "unknown";
    await dependencies.recordFinal(
      env,
      db,
      target,
      {
        id: state.attemptId as string,
        number: Number(state.attemptNumber ?? 1),
      },
      {
        outcome: "ambiguous",
        sanitizedResponse: {
          reason: "unresolved_provider_write_marker",
          phase,
        },
        error: {
          code: "ambiguous_provider_write",
          message:
            "A provider write may have succeeded, but its result was not durably recorded. Review Instagram before resolving this target.",
          retryable: false,
        },
      },
      target.publish_request_sent_at,
    );
    return queueResult(target, "ambiguous_provider_acceptance", "needs_review");
  }
  const statusHandle = state?.statusHandle as string | undefined;
  if (!statusHandle) {
    const attempt = {
      id: state?.attemptId as string,
      number: Number(state?.attemptNumber ?? 1),
    };
    await dependencies.recordFinal(
      env,
      db,
      target,
      attempt,
      {
        outcome: "ambiguous",
        sanitizedResponse: { reason: "missing_status_handle" },
        error: {
          code: "missing_status_handle",
          message:
            "The upload completed but no platform status identifier was returned.",
          retryable: false,
        },
      },
      target.publish_request_sent_at,
    );
    return queueResult(target, "ambiguous_provider_acceptance", "needs_review");
  }
  let result: PublishResult;
  try {
    result = await dependencies
      .adapterFor(target.platform, env)
      .getPublishStatus(accessToken, statusHandle);
  } catch (error) {
    const normalized = dependencies
      .adapterFor(target.platform, env)
      .normalizeError(error);
    if (normalized.retryable && !normalized.ambiguous) {
      // Polling can safely continue; this never creates another publish request.
      await dependencies.enqueueQueueJob(
        env,
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        120,
      );
      return queueResult(target, "safe_continuation", "processing");
    }
    await dependencies.recordFinal(
      env,
      db,
      target,
      {
        id: state.attemptId as string,
        number: Number(state.attemptNumber ?? 1),
      },
      {
        outcome: normalized.ambiguous ? "ambiguous" : "failed",
        sanitizedResponse: {
          code: normalized.code,
          httpStatus: normalized.httpStatus,
        },
        error: {
          code: normalized.code,
          message: normalized.message,
          retryable: false,
        },
      },
      target.publish_request_sent_at,
    );
    return queueResult(
      target,
      normalized.ambiguous
        ? "ambiguous_provider_acceptance"
        : "definite_provider_rejection",
      normalized.ambiguous ? "needs_review" : "failed",
    );
  }
  if (result.nextProviderWrite) {
    return executeDurableProviderWrite(
      env,
      db,
      target,
      accessToken,
      statusHandle,
      result.nextProviderWrite.phase,
      dependencies,
    );
  }
  if (result.outcome === "processing") {
    if (result.statusHandle && result.statusHandle !== statusHandle) {
      await db.update(`post_targets?id=eq.${target.id}`, {
        platform_upload_state: {
          ...state,
          statusHandle: result.statusHandle,
        },
      });
    }
    await dependencies.enqueueQueueJob(
      env,
      {
        targetId: target.id,
        mode: "poll",
        requestedAt: new Date().toISOString(),
      },
      60,
    );
    return queueResult(target, "safe_continuation", "processing");
  }
  if (result.outcome === "published" && result.remoteContentId) {
    const thumbnailResult = await uploadYouTubeThumbnailIfSelected(
      env,
      target,
      accessToken,
      result.remoteContentId,
    );
    if (thumbnailResult) {
      result.sanitizedResponse = {
        ...result.sanitizedResponse,
        thumbnail: thumbnailResult,
      };
    }
  }
  await dependencies.recordFinal(
    env,
    db,
    target,
    {
      id: state.attemptId as string,
      number: Number(state.attemptNumber ?? 1),
    },
    result,
    target.publish_request_sent_at,
  );
  return queueResult(target, classifyPublishResult(result), result.outcome);
}

async function executeDurableProviderWrite(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
  statusHandle: string,
  phase: string,
  dependencies: ClaimedQueueJobDependencies,
): Promise<QueueProcessResult> {
  const state = target.platform_upload_state!;
  const attempt = {
    id: state.attemptId as string,
    number: Number(state.attemptNumber ?? 1),
  };
  const adapter = dependencies.adapterFor(target.platform, env);
  if (!adapter.executePublishWrite || !/^[a-z0-9_:-]{1,100}$/.test(phase)) {
    await dependencies.recordFinal(
      env,
      db,
      target,
      attempt,
      {
        outcome: "ambiguous",
        sanitizedResponse: {
          reason: "unsupported_provider_write_continuation",
        },
        error: {
          code: "unsupported_provider_write_continuation",
          message:
            "The provider requested an unsupported publishing continuation. Review the platform before resolving this target.",
          retryable: false,
        },
      },
      target.publish_request_sent_at,
    );
    return queueResult(target, "ambiguous_provider_acceptance", "needs_review");
  }

  // Resolve all input before crossing the durable write-ahead boundary. The
  // marker update below is intentionally the final await before the Meta write.
  const publishInput = await publishInputForTarget(
    env,
    target,
    accessToken,
    dependencies,
  );
  const providerWriteSentAt = dependencies.now();
  await db.update(`post_targets?id=eq.${target.id}`, {
    status: "processing",
    platform_upload_state: {
      ...state,
      statusHandle,
      providerWrite: {
        phase,
        requestSentAt: providerWriteSentAt,
      },
    },
    updated_at: providerWriteSentAt,
  });

  let result: PublishResult;
  try {
    result = await adapter.executePublishWrite(
      publishInput,
      statusHandle,
      phase,
    );
  } catch (error) {
    const normalized = adapter.normalizeError(error);
    result = {
      outcome: normalized.ambiguous ? "ambiguous" : "failed",
      sanitizedResponse: {
        code: normalized.code,
        httpStatus: normalized.httpStatus,
        phase,
      },
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: false,
      },
    };
  }

  if (result.outcome === "processing") {
    if (!result.statusHandle) {
      result = {
        outcome: "ambiguous",
        sanitizedResponse: {
          ...result.sanitizedResponse,
          phase,
          reason: "provider_write_missing_status_handle",
        },
        error: {
          code: "missing_status_handle",
          message:
            "The provider write succeeded without a durable status identifier. Review Instagram before resolving this target.",
          retryable: false,
        },
      };
    } else {
      const { providerWrite: _completedWrite, ...priorState } = state;
      await db.update(`post_targets?id=eq.${target.id}`, {
        status: "processing",
        platform_upload_state: {
          ...priorState,
          statusHandle: result.statusHandle,
          lastProviderWrite: {
            phase,
            completedAt: dependencies.now(),
          },
        },
      });
      await db.update(`publish_attempts?id=eq.${attempt.id}`, {
        request_sent_at: target.publish_request_sent_at,
        sanitized_response: redactSecrets(result.sanitizedResponse),
      });
      await dependencies.enqueueQueueJob(
        env,
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        60,
      );
      return queueResult(target, "safe_continuation", "processing");
    }
  }

  await dependencies.recordFinal(
    env,
    db,
    target,
    attempt,
    result,
    target.publish_request_sent_at,
  );
  return queueResult(
    target,
    classifyPublishResult(result),
    result.outcome === "ambiguous" ? "needs_review" : result.outcome,
  );
}

async function uploadYouTubeThumbnailIfSelected(
  env: Env,
  target: TargetRecord,
  accessToken: string,
  videoId: string,
): Promise<"uploaded" | "not_permitted" | null> {
  if (target.platform !== "youtube") return null;
  const metadata = youTubeMetadataSchema.safeParse(target.metadata);
  if (!metadata.success) return "not_permitted";
  const thumbnailId = metadata.data.thumbnailMediaId;
  if (typeof thumbnailId !== "string") return null;
  const thumbnail = target.posts.post_media
    .map((item) => item.media_assets)
    .find((item) => item.id === thumbnailId);
  if (!thumbnail) return "not_permitted";
  const adapter = adapterFor("youtube", env);
  if (!adapter.uploadThumbnail) return "not_permitted";
  try {
    const body = await fetchMediaBody(env, {
      ...thumbnail,
      owner_id: target.owner_id,
    });
    await adapter.uploadThumbnail(
      accessToken,
      videoId,
      body,
      thumbnail.mime_type,
    );
    return "uploaded";
  } catch {
    // The video is already published; an optional thumbnail error must not make it republishable.
    return "not_permitted";
  }
}
