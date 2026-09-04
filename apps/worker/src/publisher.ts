import {
  decryptSecret,
  encryptSecret,
  redactSecrets,
  type Platform,
  type PublishResult,
} from "@scheduler/shared";
import { trustedUploadSessionUrl } from "@scheduler/platforms";

import { adapterFor } from "./adapters";
import { SupabaseRest } from "./database";
import type { Env, QueueJob } from "./env";
import { logWorkerError } from "./logging";
import { sendFailureEmailOnce } from "./notifications";
import { fetchMediaBody, fetchMediaRange, signedDeliveryUrl } from "./storage";

interface TargetRecord {
  id: string;
  owner_id: string;
  post_id: string;
  platform: Platform;
  status: string;
  metadata: Record<string, unknown>;
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
    env.TOKEN_ENCRYPTION_KEY,
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
          env.TOKEN_ENCRYPTION_KEY,
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
  const encryptedRefresh = refreshed.refreshToken
    ? await encryptSecret(
        refreshed.refreshToken,
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
      : {}),
    encryption_key_version: encryptedAccess.keyVersion,
    token_expires_at: refreshed.expiresAt,
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

export async function processQueueJob(env: Env, job: QueueJob): Promise<void> {
  const db = new SupabaseRest(env);
  const leaseOwner = `queue:${crypto.randomUUID()}`;
  const now = new Date();
  const claimed = await db.update<Array<{ id: string }>>(
    `post_targets?id=eq.${encodeURIComponent(job.targetId)}&status=in.(queued,publishing,processing)&or=(lease_expires_at.is.null,lease_expires_at.lte.${encodeURIComponent(now.toISOString())})`,
    {
      lease_owner: leaseOwner,
      lease_expires_at: new Date(now.getTime() + 10 * 60 * 1_000).toISOString(),
    },
  );
  if (!claimed.length) {
    const current = await loadTarget(db, job.targetId);
    if (
      current &&
      ["queued", "publishing", "processing"].includes(current.status)
    )
      await env.PUBLISH_QUEUE.send(
        { ...job, requestedAt: new Date().toISOString() },
        { delaySeconds: 30 },
      );
    return;
  }
  try {
    await processClaimedQueueJob(env, db, job);
  } finally {
    await db.update(
      `post_targets?id=eq.${encodeURIComponent(job.targetId)}&lease_owner=eq.${encodeURIComponent(leaseOwner)}`,
      { lease_owner: null, lease_expires_at: null },
    );
  }
}

async function processClaimedQueueJob(
  env: Env,
  db: SupabaseRest,
  job: QueueJob,
): Promise<void> {
  const target = await loadTarget(db, job.targetId);
  if (
    !target ||
    ["published", "failed", "needs_review", "cancelled"].includes(target.status)
  )
    return;
  if (env.LIVE_TEST_CONFIRM !== "true") {
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "blocked_authorization",
      last_error_code: "live_test_not_confirmed",
      last_error_message:
        "Set LIVE_TEST_CONFIRM=true only after the owner approves real publishing.",
      lease_owner: null,
      lease_expires_at: null,
    });
    return;
  }
  const adapter = adapterFor(target.platform, env);
  let accessToken: string;
  try {
    accessToken = await loadAccessToken(env, target);
  } catch {
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "blocked_authorization",
      last_error_code: "token_refresh_failed",
      last_error_message:
        "The platform token expired and could not be refreshed. Reconnect the account.",
      lease_owner: null,
      lease_expires_at: null,
    });
    return;
  }
  if (job.mode === "upload")
    return continueUploadSafely(env, db, target, accessToken);
  if (job.mode === "poll") return pollStatus(env, db, target, accessToken);

  if (target.publish_request_sent_at) {
    // A publish request might already have reached the platform. Never send another one automatically.
    if (target.platform_upload_state?.statusHandle) {
      await env.PUBLISH_QUEUE.send(
        { ...job, mode: "poll", requestedAt: new Date().toISOString() },
        { delaySeconds: 60 },
      );
    } else {
      const attempt = await nextAttempt(db, target);
      await recordFinal(env, db, target, attempt, {
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
      });
    }
    return;
  }

  const attempt = await nextAttempt(db, target);
  try {
    const selected = new Set(target.selected_media_ids);
    const mediaRows = [...target.posts.post_media]
      .filter(({ media_assets: item }) => selected.has(item.id))
      .sort((a, b) => a.sort_order - b.sort_order);
    const media = mediaRows.map(({ media_assets: item }) => ({
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
    const validation = adapter.validatePost(target.metadata as any, media);
    if (!validation.valid) {
      await recordFinal(env, db, target, attempt, {
        outcome: "failed",
        sanitizedResponse: { validation: validation.errors },
        error: {
          code: "validation_failed",
          message: validation.errors.map((issue) => issue.message).join(" "),
          retryable: false,
        },
      });
      return;
    }
    const deliveryUrls = await Promise.all(
      media.map((item) =>
        signedDeliveryUrl(env, {
          mediaId: item.id,
          ownerId: target.owner_id,
        }),
      ),
    );
    await db.update(`post_targets?id=eq.${target.id}`, {
      status: "publishing",
      publish_request_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const result = await adapter.publish({
      accountId: target.connected_accounts.remote_account_id,
      accessToken,
      idempotencyKey: target.idempotency_key,
      metadata: target.metadata as any,
      media,
      deliveryUrls,
    });
    await db.update(`publish_attempts?id=eq.${attempt.id}`, {
      request_sent_at: new Date().toISOString(),
      sanitized_response: redactSecrets(result.sanitizedResponse),
    });
    if (result.uploadSession) {
      const encrypted = await encryptSecret(
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
      await env.PUBLISH_QUEUE.send(
        {
          targetId: target.id,
          mode: "upload",
          requestedAt: new Date().toISOString(),
        },
        { delaySeconds: 1 },
      );
      return;
    }
    if (result.outcome === "processing") {
      await db.update(`post_targets?id=eq.${target.id}`, {
        status: "processing",
        platform_upload_state: {
          statusHandle: result.statusHandle,
          attemptId: attempt.id,
          attemptNumber: attempt.number,
        },
      });
      await env.PUBLISH_QUEUE.send(
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        { delaySeconds: 60 },
      );
      return;
    }
    await recordFinal(env, db, target, attempt, result);
  } catch (error) {
    const normalized = adapter.normalizeError(error);
    await recordFinal(env, db, target, attempt, {
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
    });
  }
}

async function continueUploadSafely(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
) {
  try {
    await continueUpload(env, db, target, accessToken);
  } catch (error) {
    const state = target.platform_upload_state;
    if (!state?.attemptId) throw error;
    const normalized = adapterFor(target.platform, env).normalizeError(error);
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
      await env.PUBLISH_QUEUE.send(
        {
          targetId: target.id,
          mode: "upload",
          requestedAt: new Date().toISOString(),
        },
        { delaySeconds: Math.min(30 * 2 ** uploadRetryCount, 900) },
      );
      return;
    }
    if (normalized.ambiguous && state.statusHandle) {
      // The last chunk may have completed. Reconcile the existing provider job; never re-initiate it.
      await db.update(`post_targets?id=eq.${target.id}`, {
        status: "processing",
        platform_upload_state: { ...state, uploadComplete: "uncertain" },
      });
      await env.PUBLISH_QUEUE.send(
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        { delaySeconds: 120 },
      );
      return;
    }
    await recordFinal(
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
    );
  }
}

async function continueUpload(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
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
    env.TOKEN_ENCRYPTION_KEY,
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
  let response: Response;
  try {
    response = await fetch(trustedUrl, {
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
    });
  } catch {
    throw {
      name: "NetworkError",
      code: "upload_network_error",
      message: "Resumable upload request failed",
      ambiguous: true,
    };
  }
  const accepted =
    response.ok || (target.platform === "youtube" && response.status === 308);
  if (!accepted)
    throw {
      status: response.status,
      body: { message: (await response.text()).slice(0, 500) },
    };
  const nextByte = acceptedUploadByte(target.platform, response, endExclusive);
  if (nextByte === start) {
    throw {
      status: 503,
      body: { message: "Resumable upload made no progress" },
    };
  }
  if (nextByte < Number(state.totalBytes)) {
    await db.update(`post_targets?id=eq.${target.id}`, {
      platform_upload_state: { ...state, nextByte, uploadRetryCount: 0 },
    });
    await env.PUBLISH_QUEUE.send(
      {
        targetId: target.id,
        mode: "upload",
        requestedAt: new Date().toISOString(),
      },
      { delaySeconds: 1 },
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
  await env.PUBLISH_QUEUE.send(
    {
      targetId: target.id,
      mode: "poll",
      requestedAt: new Date().toISOString(),
    },
    { delaySeconds: 60 },
  );
}

async function pollStatus(
  env: Env,
  db: SupabaseRest,
  target: TargetRecord,
  accessToken: string,
) {
  const state = target.platform_upload_state;
  if (!state?.attemptId) throw new Error("Publish attempt state is missing");
  const statusHandle = state?.statusHandle as string | undefined;
  if (!statusHandle) {
    const attempt = {
      id: state?.attemptId as string,
      number: Number(state?.attemptNumber ?? 1),
    };
    await recordFinal(env, db, target, attempt, {
      outcome: "ambiguous",
      sanitizedResponse: { reason: "missing_status_handle" },
      error: {
        code: "missing_status_handle",
        message:
          "The upload completed but no platform status identifier was returned.",
        retryable: false,
      },
    });
    return;
  }
  try {
    const result = await adapterFor(target.platform, env).getPublishStatus(
      accessToken,
      statusHandle,
    );
    if (result.outcome === "processing") {
      if (result.statusHandle && result.statusHandle !== statusHandle) {
        await db.update(`post_targets?id=eq.${target.id}`, {
          platform_upload_state: {
            ...state,
            statusHandle: result.statusHandle,
          },
        });
      }
      await env.PUBLISH_QUEUE.send(
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        { delaySeconds: 60 },
      );
      return;
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
    await recordFinal(
      env,
      db,
      target,
      {
        id: state.attemptId as string,
        number: Number(state.attemptNumber ?? 1),
      },
      result,
    );
  } catch (error) {
    const normalized = adapterFor(target.platform, env).normalizeError(error);
    if (normalized.retryable && !normalized.ambiguous) {
      // Polling can safely continue; this never creates another publish request.
      await env.PUBLISH_QUEUE.send(
        {
          targetId: target.id,
          mode: "poll",
          requestedAt: new Date().toISOString(),
        },
        { delaySeconds: 120 },
      );
      return;
    }
    await recordFinal(
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
    );
  }
}

async function uploadYouTubeThumbnailIfSelected(
  env: Env,
  target: TargetRecord,
  accessToken: string,
  videoId: string,
): Promise<"uploaded" | "not_permitted" | null> {
  if (target.platform !== "youtube") return null;
  const thumbnailId = target.metadata.thumbnailMediaId;
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
