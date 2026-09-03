import {
  createPostSchema,
  localMelbourneToUtc,
  paginationSchema,
  platformSchema,
  securityHeaders,
  type PlatformMetadata,
} from "@scheduler/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { syncAnalyticsBatch } from "./analytics";
import { adapterFor } from "./adapters";
import type { Variables } from "./auth";
import { ownerAuth } from "./auth";
import {
  configurationStatus,
  assertProductionConfigured,
  type Env,
  type QueueJob,
} from "./env";
import { ownerDatabase, SupabaseRest } from "./database";
import oauthRoutes from "./oauth-routes";
import { processQueueJob, updateMediaRetentionForPost } from "./publisher";
import {
  ACTIVE_MEDIA_LIMIT_BYTES,
  deleteUploadThingFile,
  deliveryResponse,
  MediaStorageError,
  reservationDeletionTarget,
  type StoredMedia,
  verifyDeliveryRequest,
} from "./storage";
import { handleUploadThingRequest } from "./uploadthing";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(securityHeaders()))
    c.header(name, value);
  await next();
});

app.use(
  "/api/*",
  cors({
    origin: (origin, c) => (origin === c.env.APP_URL ? origin : ""),
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "B3",
      "Traceparent",
      "X-Uploadthing-Package",
      "X-Uploadthing-Version",
    ],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    maxAge: 600,
  }),
);

app.onError((error, c) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: error.message,
      requestId: c.req.header("CF-Ray"),
    }),
  );
  return c.json(
    {
      error: "request_failed",
      message: "The request could not be completed safely.",
    },
    500,
  );
});

app.get("/health", (c) => {
  const status = configurationStatus(c.env);
  const healthy = c.env.ENVIRONMENT !== "production" || status.configured;
  return c.json(
    {
      status: healthy ? "ok" : "configuration_required",
      configured: status.configured,
      environment: status.environment,
    },
    healthy ? 200 : 503,
  );
});

app.on(["GET", "HEAD"], "/delivery/:encodedKey", async (c) => {
  const reference = await verifyDeliveryRequest(
    c.env,
    c.req.param("encodedKey"),
    c.req.query("expires"),
    c.req.query("signature"),
  );
  if (!reference) return c.body(null, 403);
  const rows = await new SupabaseRest(c.env).select<StoredMedia[]>(
    `media_assets?id=eq.${encodeURIComponent(reference.mediaId)}&owner_id=eq.${encodeURIComponent(reference.ownerId)}&storage_provider=eq.uploadthing&upload_status=eq.complete&deleted_at=is.null&select=id,owner_id,storage_provider,provider_file_key,provider_url,object_key,mime_type,size_bytes,upload_status,deleted_at&limit=1`,
  );
  const media = rows[0];
  if (!media) return c.body(null, 404);
  try {
    return await deliveryResponse(
      c.env,
      media,
      c.req.method as "GET" | "HEAD",
      c.req.header("Range"),
    );
  } catch (error) {
    if (error instanceof MediaStorageError)
      return c.json({ error: error.code }, error.status as 404 | 416 | 502);
    throw error;
  }
});

app.route("/api/oauth", oauthRoutes);
app.on(["GET", "POST"], "/api/uploadthing", (c) =>
  handleUploadThingRequest(c.env, c.req.raw),
);
app.use("/api/*", ownerAuth);

app.get("/api/setup", (c) => c.json(configurationStatus(c.env)));

app.get("/api/storage", async (c) => {
  const rows = await ownerDatabase(c.env, c.get("jwt")).rpc<
    Array<{
      active_bytes: number;
      reserved_bytes: number;
      limit_bytes: number;
    }>
  >("uploadthing_storage_usage", {});
  const usage = rows[0] ?? {
    active_bytes: 0,
    reserved_bytes: 0,
    limit_bytes: ACTIVE_MEDIA_LIMIT_BYTES,
  };
  return c.json({
    activeBytes: Number(usage.active_bytes),
    reservedBytes: Number(usage.reserved_bytes),
    limitBytes: Number(usage.limit_bytes),
    providerPlanBytes: 2 * 1024 ** 3,
  });
});

app.get("/api/accounts", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.select(
    `connected_accounts?owner_id=eq.${c.get("user").id}&select=id,platform,username,scopes,token_expires_at,connection_status,approval_state,metadata&order=platform`,
  );
  return c.json({ data: rows });
});

app.delete("/api/accounts/:id", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.select<Array<Record<string, any>>>(
    `connected_accounts?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&select=*&limit=1`,
  );
  const account = rows[0];
  if (!account) return c.json({ error: "account_not_found" }, 404);
  const { decryptSecret } = await import("@scheduler/shared");
  const { adapterFor } = await import("./adapters");
  const accessToken = await decryptSecret(
    {
      ciphertext: account.encrypted_access_token,
      nonce: account.access_token_nonce,
      algorithm: "AES-GCM",
      keyVersion: account.encryption_key_version,
    },
    c.env.TOKEN_ENCRYPTION_KEY,
  );
  await adapterFor(account.platform, c.env).disconnect(accessToken);
  await db.update(
    `connected_accounts?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}`,
    {
      connection_status: "disconnected",
      encrypted_access_token: "revoked",
      access_token_nonce: "revoked",
      encrypted_refresh_token: null,
      refresh_token_nonce: null,
      updated_at: new Date().toISOString(),
    },
  );
  return c.json({ ok: true });
});

app.get("/api/queue", async (c) => {
  const parsed = paginationSchema.safeParse(c.req.query());
  if (!parsed.success)
    return c.json(
      { error: "invalid_pagination", issues: parsed.error.issues },
      400,
    );
  const { limit, cursor, status, platform } = parsed.data;
  const view = c.req.query("view") ?? "queue";
  if (!["queue", "published", "failed", "all"].includes(view))
    return c.json({ error: "invalid_queue_view" }, 400);
  const viewFilter =
    view === "queue"
      ? "status=in.(draft,scheduled,blocked_authorization,queued,publishing,processing)"
      : view === "published"
        ? "status=eq.published"
        : view === "failed"
          ? "status=in.(failed,needs_review)"
          : "";
  const filters = [
    `owner_id=eq.${c.get("user").id}`,
    status ? `status=eq.${status}` : "",
    status ? "" : viewFilter,
    platform ? `platform=eq.${platform}` : "",
    cursor ? `id=lt.${encodeURIComponent(cursor)}` : "",
  ].filter(Boolean);
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = (await db.select(
    `post_targets?${filters.join("&")}&select=id,post_id,platform,status,scheduled_at_utc,remote_url,last_error_message,posts(title,base_caption,post_media(media_assets(id)))&order=id.desc&limit=${limit + 1}`,
  )) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  return c.json({
    data,
    nextCursor: hasMore ? data.at(-1)?.id : null,
    hasMore,
  });
});

app.get("/api/analytics", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const requestedPlatform = c.req.query("platform");
  const platform = platformSchema.safeParse(requestedPlatform);
  if (requestedPlatform && !platform.success)
    return c.json({ error: "invalid_platform" }, 400);
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (
    (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
    (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))
  )
    return c.json({ error: "invalid_date_range" }, 400);
  const filters = [
    `owner_id=eq.${c.get("user").id}`,
    platform.success ? `platform=eq.${platform.data}` : "",
    from ? `captured_at=gte.${from}T00:00:00Z` : "",
    to ? `captured_at=lte.${to}T23:59:59Z` : "",
  ].filter(Boolean);
  const data = await db.select(
    `analytics_snapshots?${filters.join("&")}&select=id,post_target_id,platform,captured_at,period_start,period_end,normalized_metrics,raw_metrics,unavailable_metrics,post_targets(metadata,remote_url,posts(title))&order=captured_at.desc&limit=500`,
  );
  return c.json({ data });
});

app.get("/api/analytics/:targetId", async (c) => {
  const targetId = c.req.param("targetId");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(targetId))
    return c.json({ error: "invalid_target_id" }, 400);
  const db = ownerDatabase(c.env, c.get("jwt"));
  const data = await db.select(
    `analytics_snapshots?owner_id=eq.${c.get("user").id}&post_target_id=eq.${encodeURIComponent(targetId)}&select=id,post_target_id,platform,captured_at,period_start,period_end,normalized_metrics,raw_metrics,unavailable_metrics,post_targets(metadata,remote_url,posts(title))&order=captured_at.desc&limit=500`,
  );
  return c.json({ data });
});

app.get("/api/export", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const owner = c.get("user").id;
  const [accounts, media, posts, targets, attempts, analytics, audit] =
    await Promise.all([
      db.select(
        `connected_accounts?owner_id=eq.${owner}&select=id,platform,remote_account_id,username,scopes,token_expires_at,connection_status,approval_state,metadata,created_at,updated_at&limit=10000`,
      ),
      db.select(
        `media_assets?owner_id=eq.${owner}&select=id,original_filename,mime_type,size_bytes,width,height,duration_seconds,upload_status,retain_until,deletion_blocked_reason,deleted_at,created_at&limit=10000`,
      ),
      db.select(`posts?owner_id=eq.${owner}&select=*&limit=10000`),
      db.select(
        `post_targets?owner_id=eq.${owner}&select=id,post_id,connected_account_id,platform,status,metadata,selected_media_ids,scheduled_at_utc,idempotency_key,remote_content_id,remote_url,last_error_code,last_error_message,published_at,created_at,updated_at&limit=10000`,
      ),
      db.select(`publish_attempts?owner_id=eq.${owner}&select=*&limit=10000`),
      db.select(
        `analytics_snapshots?owner_id=eq.${owner}&select=*&limit=10000`,
      ),
      db.select(`audit_log?owner_id=eq.${owner}&select=*&limit=10000`),
    ]);
  return c.json({
    exportedAt: new Date().toISOString(),
    warning:
      "Encrypted platform credentials, OAuth state secrets, provider file keys, and email provider IDs are intentionally excluded.",
    accounts,
    media,
    posts,
    targets,
    attempts,
    analytics,
    audit,
  });
});

app.post("/api/installation/delete", async (c) => {
  const input = (await c.req.json()) as { confirmation?: string };
  if (input.confirmation !== "DELETE")
    return c.json(
      { error: "confirmation_required", message: "Type DELETE to confirm." },
      400,
    );
  const ownerDb = ownerDatabase(c.env, c.get("jwt"));
  const allowed = await ownerDb.rpc<boolean>("consume_rate_limit", {
    p_route: "installation_delete",
    p_limit: 1,
    p_window_seconds: 3600,
  });
  if (!allowed) return c.json({ error: "rate_limit_exceeded" }, 429);
  const ownerId = c.get("user").id;
  const active = await ownerDb.select<Array<{ id: string }>>(
    `post_targets?owner_id=eq.${ownerId}&status=in.(queued,publishing,processing)&select=id&limit=1`,
  );
  if (active.length)
    return c.json(
      {
        error: "publication_in_progress",
        message: "Wait for active publication jobs before deleting data.",
      },
      409,
    );
  const serviceDb = new SupabaseRest(c.env);
  const accounts = await serviceDb.select<Array<Record<string, any>>>(
    `connected_accounts?owner_id=eq.${ownerId}&select=*`,
  );
  for (const account of accounts) {
    try {
      const { decryptSecret } = await import("@scheduler/shared");
      const token = await decryptSecret(
        {
          ciphertext: account.encrypted_access_token,
          nonce: account.access_token_nonce,
          algorithm: "AES-GCM",
          keyVersion: account.encryption_key_version,
        },
        c.env.TOKEN_ENCRYPTION_KEY,
      );
      await adapterFor(account.platform, c.env).disconnect(token);
    } catch {
      // Continue local erasure when a provider token is already invalid or unreachable.
    }
  }
  const media = await serviceDb.select<
    Array<{
      id: string;
      storage_provider: string;
      provider_file_key: string | null;
    }>
  >(
    `media_assets?owner_id=eq.${ownerId}&deleted_at=is.null&select=id,storage_provider,provider_file_key`,
  );
  const unsupported = media.find(
    (item) => item.storage_provider !== "uploadthing",
  );
  if (unsupported)
    return c.json(
      {
        error: "legacy_media_requires_review",
        message:
          "A legacy media record must be resolved before deleting the installation.",
      },
      409,
    );
  for (const item of media) {
    await serviceDb.update(`media_assets?id=eq.${item.id}`, {
      deletion_status: "pending",
      deletion_attempted_at: new Date().toISOString(),
      deletion_last_error: null,
    });
    try {
      const deletion = reservationDeletionTarget(item);
      await deleteUploadThingFile(c.env, deletion.identifier, deletion.keyType);
      await serviceDb.update(`media_assets?id=eq.${item.id}`, {
        deletion_status: "confirmed",
        provider_deleted_at: new Date().toISOString(),
        upload_status: "deleted",
        deleted_at: new Date().toISOString(),
        deletion_last_error: null,
      });
    } catch {
      await serviceDb.update(`media_assets?id=eq.${item.id}`, {
        deletion_status: "failed",
        deletion_last_error: "provider_delete_not_confirmed",
      });
      return c.json(
        {
          error: "provider_delete_not_confirmed",
          message:
            "UploadThing did not confirm every file deletion. Installation data was preserved for a safe retry.",
        },
        502,
      );
    }
  }
  await serviceDb.rpc("delete_installation_data", { p_owner_id: ownerId });
  const authResponse = await fetch(
    `${c.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users/${encodeURIComponent(ownerId)}`,
    {
      method: "DELETE",
      headers: {
        apikey: c.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  return c.json({ ok: true, authUserDeleted: authResponse.ok });
});

app.post("/api/posts", async (c) => {
  const parsed = createPostSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_post", issues: parsed.error.issues }, 400);
  const scheduled = localMelbourneToUtc(parsed.data.scheduledLocal);
  if (!scheduled.valid || !scheduled.utc)
    return c.json(
      {
        error: scheduled.ambiguous
          ? "ambiguous_schedule_time"
          : "invalid_schedule_time",
        message: scheduled.reason,
      },
      400,
    );
  const db = ownerDatabase(c.env, c.get("jwt"));
  const mediaRows = await db.select<
    Array<{
      id: string;
      object_key: string;
      storage_provider: string;
      provider_file_key: string | null;
      provider_url: string | null;
      mime_type: string;
      size_bytes: number;
      width?: number;
      height?: number;
      duration_seconds?: number;
    }>
  >(
    `media_assets?owner_id=eq.${c.get("user").id}&id=in.(${parsed.data.mediaIds.map(encodeURIComponent).join(",")})&storage_provider=eq.uploadthing&upload_status=eq.complete&deleted_at=is.null&select=id,object_key,storage_provider,provider_file_key,provider_url,mime_type,size_bytes,width,height,duration_seconds`,
  );
  if (mediaRows.length !== new Set(parsed.data.mediaIds).size)
    return c.json(
      {
        error: "invalid_media_selection",
        message: "Every selected media item must be uploaded by the owner.",
      },
      400,
    );
  const media = parsed.data.mediaIds.map((mediaId) => {
    const item = mediaRows.find((candidate) => candidate.id === mediaId)!;
    return {
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
    };
  });
  const validation = parsed.data.targets.flatMap((target) => {
    const selected = new Set(target.mediaIds ?? parsed.data.mediaIds);
    const targetMedia = media.filter((item) => selected.has(item.id));
    const result = adapterFor(target.platform, c.env).validatePost(
      target.metadata as PlatformMetadata,
      targetMedia,
    );
    return result.errors.map((issue) => ({
      platform: target.platform,
      ...issue,
    }));
  });
  if (validation.length)
    return c.json(
      {
        error: "platform_validation_failed",
        message: validation.map((issue) => issue.message).join(" "),
        issues: validation,
      },
      400,
    );
  const id = await db.rpc<string>("create_scheduled_post", {
    p_title: parsed.data.title,
    p_base_caption: parsed.data.baseCaption,
    p_scheduled_at_utc: scheduled.utc,
    p_media_ids: parsed.data.mediaIds,
    p_targets: parsed.data.targets,
  });
  return c.json({ id }, 201);
});

app.patch("/api/targets/:id/cancel", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.update<Array<{ id: string }>>(
    `post_targets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&status=in.(draft,scheduled,blocked_authorization)`,
    { status: "cancelled", updated_at: new Date().toISOString() },
  );
  if (!rows.length) return c.json({ error: "target_not_cancellable" }, 409);
  return c.json({ ok: true });
});

app.post("/api/targets/:id/retry", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const target = await db.rpc("begin_manual_retry", {
    p_target_id: c.req.param("id"),
  });
  return c.json({ data: target });
});

app.post("/api/targets/:id/resolve", async (c) => {
  const input = (await c.req.json()) as {
    outcome?: string;
    remoteContentId?: string;
    remoteUrl?: string;
  };
  if (!input || !["published", "failed"].includes(input.outcome ?? ""))
    return c.json({ error: "invalid_resolution" }, 400);
  if (input.remoteUrl) {
    try {
      if (new URL(input.remoteUrl).protocol !== "https:")
        return c.json({ error: "invalid_remote_url" }, 400);
    } catch {
      return c.json({ error: "invalid_remote_url" }, 400);
    }
  }
  const db = ownerDatabase(c.env, c.get("jwt"));
  const existing = await db.select<Array<{ id: string; post_id: string }>>(
    `post_targets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&status=eq.needs_review&select=id,post_id&limit=1`,
  );
  if (!existing.length)
    return c.json({ error: "target_not_awaiting_resolution" }, 409);
  const outcome = input.outcome as "published" | "failed";
  await db.update(
    `post_targets?id=eq.${existing[0]!.id}&owner_id=eq.${c.get("user").id}&status=eq.needs_review`,
    {
      status: outcome,
      ...(outcome === "published"
        ? {
            published_at: new Date().toISOString(),
            ...(input.remoteContentId
              ? { remote_content_id: input.remoteContentId.slice(0, 255) }
              : {}),
            ...(input.remoteUrl ? { remote_url: input.remoteUrl } : {}),
            last_error_code: null,
            last_error_message: null,
          }
        : {
            last_error_code: "owner_confirmed_absent",
            last_error_message:
              "The owner checked the platform and confirmed no content exists.",
          }),
      updated_at: new Date().toISOString(),
    },
  );
  await updateMediaRetentionForPost(
    new SupabaseRest(c.env),
    existing[0]!.post_id,
  );
  return c.json({ ok: true, status: outcome });
});

app.delete("/api/media/:id", async (c) => {
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.select<
    Array<{
      id: string;
      storage_provider: string;
      provider_file_key: string | null;
    }>
  >(
    `media_assets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&deleted_at=is.null&select=id,storage_provider,provider_file_key&limit=1`,
  );
  const media = rows[0];
  if (!media) return c.json({ error: "media_not_found" }, 404);
  const links = await db.select<
    Array<{ posts: { post_targets: Array<{ status: string }> } }>
  >(
    `post_media?media_asset_id=eq.${media.id}&select=posts(post_targets(status))`,
  );
  const statuses = links.flatMap(
    (link) => link.posts?.post_targets?.map((target) => target.status) ?? [],
  );
  if (statuses.some((status) => !["published", "cancelled"].includes(status)))
    return c.json(
      {
        error: "media_still_required",
        message:
          "Media for scheduled, incomplete, failed, or ambiguous targets must be retained.",
      },
      409,
    );
  if (media.storage_provider !== "uploadthing")
    return c.json(
      {
        error: "media_provider_unavailable",
        message: "This legacy or incomplete media record requires review.",
      },
      409,
    );
  await db.update(
    `media_assets?id=eq.${media.id}&owner_id=eq.${c.get("user").id}`,
    {
      deletion_status: "pending",
      deletion_attempted_at: new Date().toISOString(),
      deletion_last_error: null,
    },
  );
  try {
    const deletion = reservationDeletionTarget(media);
    await deleteUploadThingFile(c.env, deletion.identifier, deletion.keyType);
  } catch {
    await db.update(
      `media_assets?id=eq.${media.id}&owner_id=eq.${c.get("user").id}`,
      {
        deletion_status: "failed",
        deletion_last_error: "provider_delete_not_confirmed",
      },
    );
    return c.json(
      {
        error: "provider_delete_not_confirmed",
        message:
          "UploadThing did not confirm deletion. The record was retained.",
      },
      502,
    );
  }
  await db.update(
    `media_assets?id=eq.${media.id}&owner_id=eq.${c.get("user").id}`,
    {
      upload_status: "deleted",
      deleted_at: new Date().toISOString(),
      provider_deleted_at: new Date().toISOString(),
      deletion_status: "confirmed",
      deletion_last_error: null,
      updated_at: new Date().toISOString(),
    },
  );
  return c.json({ ok: true });
});

app.post("/api/analytics/sync", async (c) => {
  const allowed = await ownerDatabase(c.env, c.get("jwt")).rpc<boolean>(
    "consume_rate_limit",
    { p_route: "analytics_sync", p_limit: 5, p_window_seconds: 60 },
  );
  if (!allowed) return c.json({ error: "rate_limit_exceeded" }, 429);
  return c.json({ synced: await syncAnalyticsBatch(c.env, 25) });
});

app.get("/api/capabilities/:platform", (c) => {
  const parsed = platformSchema.safeParse(c.req.param("platform") ?? "");
  if (!parsed.success) return c.json({ error: "unsupported_platform" }, 404);
  return c.json(adapterFor(parsed.data, c.env).getCapabilities());
});

const worker = {
  fetch: app.fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ) {
    assertProductionConfigured(env);
    const db = new SupabaseRest(env);
    await syncConfiguredApprovalStates(env, db);
    const workerId = crypto.randomUUID();
    const claimed = await db.rpc<Array<{ id: string }>>("claim_due_targets", {
      p_worker_id: workerId,
      p_limit: 100,
      p_lease_seconds: 300,
    });
    for (const target of claimed) {
      // Once status is queued, the consumer takes its own atomic lease.
      await db.update(`post_targets?id=eq.${target.id}`, {
        lease_owner: null,
        lease_expires_at: null,
      });
      try {
        await env.PUBLISH_QUEUE.send({
          targetId: target.id,
          mode: "publish",
          requestedAt: new Date().toISOString(),
        });
      } catch (error) {
        // No provider request exists yet, so the next cron may safely dispatch again.
        await db.update(`post_targets?id=eq.${target.id}`, {
          status: "scheduled",
          last_error_code: "queue_dispatch_failed",
          last_error_message: "Queue dispatch failed before publication began.",
          lease_owner: null,
          lease_expires_at: null,
        });
        console.error(
          JSON.stringify({
            level: "error",
            message:
              error instanceof Error ? error.message : "queue_dispatch_failed",
            targetId: target.id,
          }),
        );
      }
    }
    const scheduledMinute = new Date(controller.scheduledTime).getUTCMinutes();
    if (scheduledMinute === 17) context.waitUntil(syncAnalyticsBatch(env, 25));
    if (scheduledMinute === 23) {
      context.waitUntil(cleanupMedia(env));
      context.waitUntil(cleanupExpiredReservations(env));
    }
  },
  async queue(batch: MessageBatch<QueueJob>, env: Env) {
    assertProductionConfigured(env);
    for (const message of batch.messages) {
      try {
        await processQueueJob(env, message.body);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message:
              error instanceof Error ? error.message : "queue_job_failed",
            targetId: message.body.targetId,
          }),
        );
      } finally {
        // API failures are recorded. Infrastructure delivery is acknowledged and never automatically retried.
        message.ack();
      }
    }
  },
};

async function syncConfiguredApprovalStates(env: Env, db: SupabaseRest) {
  const approvals = {
    instagram: env.META_APP_REVIEW_APPROVED === "true",
    tiktok: env.TIKTOK_CONTENT_POSTING_AUDITED === "true",
    youtube: env.YOUTUBE_API_AUDIT_APPROVED === "true",
  } as const;
  await Promise.all(
    Object.entries(approvals).map(([platform, approved]) =>
      db.update(
        `connected_accounts?platform=eq.${platform}&connection_status=eq.connected`,
        {
          approval_state: approved ? "approved" : "pending",
          updated_at: new Date().toISOString(),
        },
      ),
    ),
  );
}

async function cleanupMedia(env: Env) {
  const db = new SupabaseRest(env);
  const rows = await db.select<
    Array<{
      id: string;
      storage_provider: string;
      provider_file_key: string | null;
    }>
  >(
    "media_assets?retain_until=lte.now()&storage_provider=eq.uploadthing&upload_status=eq.complete&deleted_at=is.null&deletion_blocked_reason=is.null&select=id,storage_provider,provider_file_key&limit=100",
  );
  for (const item of rows) {
    const links = await db.select<
      Array<{ posts: { post_targets: Array<{ status: string }> } }>
    >(
      `post_media?media_asset_id=eq.${item.id}&select=posts(post_targets(status))`,
    );
    const statuses = links.flatMap(
      (link) => link.posts?.post_targets?.map((target) => target.status) ?? [],
    );
    if (!statuses.length || statuses.some((status) => status !== "published"))
      continue;
    if (!item.provider_file_key) continue;
    await deleteMediaFromUploadThing(env, db, item.id, item.provider_file_key);
  }
}

async function cleanupExpiredReservations(env: Env) {
  const db = new SupabaseRest(env);
  const rows = await db.select<
    Array<{ id: string; provider_file_key: string | null }>
  >(
    "media_assets?storage_provider=eq.uploadthing&upload_status=eq.uploading&reservation_expires_at=lte.now()&deleted_at=is.null&select=id,provider_file_key&limit=100",
  );
  for (const item of rows) {
    try {
      await db.update(`media_assets?id=eq.${item.id}`, {
        deletion_status: "pending",
        deletion_attempted_at: new Date().toISOString(),
        deletion_last_error: null,
      });
      const deletion = reservationDeletionTarget(item);
      await deleteUploadThingFile(env, deletion.identifier, deletion.keyType);
      const deletedAt = new Date().toISOString();
      await db.update(`media_assets?id=eq.${item.id}`, {
        upload_status: "aborted",
        deletion_status: "confirmed",
        provider_deleted_at: deletedAt,
        deleted_at: deletedAt,
        deletion_last_error: null,
        updated_at: deletedAt,
      });
    } catch {
      await db.update(`media_assets?id=eq.${item.id}`, {
        deletion_status: "failed",
        deletion_last_error: "provider_delete_not_confirmed",
        updated_at: new Date().toISOString(),
      });
    }
  }
}

async function deleteMediaFromUploadThing(
  env: Env,
  db: SupabaseRest,
  mediaId: string,
  providerFileKey: string,
) {
  await db.update(`media_assets?id=eq.${mediaId}`, {
    deletion_status: "pending",
    deletion_attempted_at: new Date().toISOString(),
    deletion_last_error: null,
  });
  try {
    await deleteUploadThingFile(env, providerFileKey);
    const deletedAt = new Date().toISOString();
    await db.update(`media_assets?id=eq.${mediaId}`, {
      upload_status: "deleted",
      deletion_status: "confirmed",
      provider_deleted_at: deletedAt,
      deleted_at: deletedAt,
      deletion_last_error: null,
      updated_at: deletedAt,
    });
  } catch {
    await db.update(`media_assets?id=eq.${mediaId}`, {
      deletion_status: "failed",
      deletion_last_error: "provider_delete_not_confirmed",
      updated_at: new Date().toISOString(),
    });
  }
}

export default worker;
