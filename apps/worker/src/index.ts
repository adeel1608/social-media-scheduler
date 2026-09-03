import {
  createPostSchema,
  createMediaUploadSchema,
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
  completeMultipart,
  createUpload,
  signMultipartPart,
  verifyDeliveryRequest,
} from "./storage";

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
    allowHeaders: ["Authorization", "Content-Type"],
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
  const objectKey = await verifyDeliveryRequest(
    c.env,
    c.req.param("encodedKey"),
    c.req.query("expires"),
    c.req.query("signature"),
  );
  if (!objectKey) return c.body(null, 403);
  const metadata = await c.env.MEDIA_BUCKET.head(objectKey);
  if (!metadata) return c.body(null, 404);
  const rangeHeader = c.req.header("Range");
  let range: { offset: number; length: number } | undefined;
  if (rangeHeader && c.req.method === "GET") {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!match) return c.body(null, 416);
    const offset = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : metadata.size - 1;
    const end = Math.min(requestedEnd, metadata.size - 1);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > end)
      return c.body(null, 416);
    range = { offset, length: end - offset + 1 };
  }
  const object =
    c.req.method === "HEAD"
      ? null
      : await c.env.MEDIA_BUCKET.get(objectKey, range ? { range } : undefined);
  if (c.req.method === "GET" && !object) return c.body(null, 404);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Length": String(range?.length ?? metadata.size),
    ETag: metadata.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  metadata.writeHttpMetadata(headers);
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`,
    );
  return new Response(object?.body ?? null, {
    status: range ? 206 : 200,
    headers,
  });
});

app.route("/api/oauth", oauthRoutes);
app.use("/api/*", ownerAuth);

app.get("/api/setup", (c) => c.json(configurationStatus(c.env)));

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
      "Encrypted platform credentials, OAuth state secrets, object keys, and email provider IDs are intentionally excluded.",
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
  const media = await serviceDb.select<Array<{ object_key: string }>>(
    `media_assets?owner_id=eq.${ownerId}&deleted_at=is.null&select=object_key`,
  );
  for (let index = 0; index < media.length; index += 1_000)
    await c.env.MEDIA_BUCKET.delete(
      media.slice(index, index + 1_000).map((item) => item.object_key),
    );
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
      mime_type: string;
      size_bytes: number;
      width?: number;
      height?: number;
      duration_seconds?: number;
    }>
  >(
    `media_assets?owner_id=eq.${c.get("user").id}&id=in.(${parsed.data.mediaIds.map(encodeURIComponent).join(",")})&upload_status=eq.complete&select=id,object_key,mime_type,size_bytes,width,height,duration_seconds`,
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
  const rows = await db.select<Array<{ id: string; object_key: string }>>(
    `media_assets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&deleted_at=is.null&select=id,object_key&limit=1`,
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
  if (
    statuses.some((status) =>
      ["queued", "publishing", "processing", "needs_review"].includes(status),
    )
  )
    return c.json(
      {
        error: "media_still_required",
        message:
          "Resolve active or ambiguous targets before deleting their source media.",
      },
      409,
    );
  await c.env.MEDIA_BUCKET.delete(media.object_key);
  await db.update(
    `media_assets?id=eq.${media.id}&owner_id=eq.${c.get("user").id}`,
    {
      upload_status: "deleted",
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  );
  return c.json({ ok: true });
});

app.post("/api/uploads", async (c) => {
  const allowed = await ownerDatabase(c.env, c.get("jwt")).rpc<boolean>(
    "consume_rate_limit",
    { p_route: "upload_start", p_limit: 30, p_window_seconds: 60 },
  );
  if (!allowed) return c.json({ error: "rate_limit_exceeded" }, 429);
  const parsed = createMediaUploadSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json({ error: "invalid_media", issues: parsed.error.issues }, 400);
  const input = parsed.data;
  const upload = await createUpload(c.env, c.get("user").id, input);
  if (!upload.ok)
    return c.json({ error: "invalid_media", issues: upload.issues }, 400);
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.insert<Array<{ id: string }>>("media_assets", {
    owner_id: c.get("user").id,
    object_key: upload.objectKey,
    original_filename: input.filename,
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
    width: input.width,
    height: input.height,
    duration_seconds: input.durationSeconds,
    upload_status: "uploading",
    ...(upload.mode === "multipart" ? { upload_id: upload.uploadId } : {}),
  });
  return c.json({ mediaId: rows[0]!.id, ...upload }, 201);
});

app.post("/api/uploads/:id/part", async (c) => {
  const input = (await c.req.json()) as { partNumber: number };
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.select<
    Array<{ object_key: string; upload_id: string }>
  >(
    `media_assets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&upload_status=eq.uploading&upload_id=not.is.null&select=object_key,upload_id&limit=1`,
  );
  const media = rows[0];
  if (
    !media ||
    !Number.isInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > 10_000
  ) {
    return c.json({ error: "invalid_upload_part" }, 400);
  }
  return c.json(
    await signMultipartPart(c.env, {
      objectKey: media.object_key,
      uploadId: media.upload_id,
      partNumber: input.partNumber,
    }),
  );
});

app.post("/api/uploads/:id/complete", async (c) => {
  const input = (await c.req.json()) as { parts: R2UploadedPart[] };
  const db = ownerDatabase(c.env, c.get("jwt"));
  const rows = await db.select<
    Array<{ object_key: string; upload_id: string | null }>
  >(
    `media_assets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}&upload_status=eq.uploading&select=object_key,upload_id&limit=1`,
  );
  const media = rows[0];
  if (!media) return c.json({ error: "upload_not_found" }, 404);
  if (media.upload_id)
    await completeMultipart(c.env, {
      objectKey: media.object_key,
      uploadId: media.upload_id,
      parts: input.parts,
    });
  else if (!(await c.env.MEDIA_BUCKET.head(media.object_key)))
    return c.json({ error: "uploaded_object_not_found" }, 409);
  await db.update(
    `media_assets?id=eq.${encodeURIComponent(c.req.param("id"))}&owner_id=eq.${c.get("user").id}`,
    {
      upload_status: "complete",
      uploaded_parts: input.parts,
      upload_id: null,
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
      context.waitUntil(abortStaleUploads(env));
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
  const rows = await db.select<Array<{ id: string; object_key: string }>>(
    "media_assets?retain_until=lte.now()&deleted_at=is.null&deletion_blocked_reason=is.null&select=id,object_key&limit=100",
  );
  for (const item of rows) {
    const targets = await db.select<Array<{ status: string }>>(
      `post_media?media_asset_id=eq.${item.id}&select=posts(post_targets(status))`,
    );
    const serialized = JSON.stringify(targets);
    if (
      serialized.includes('"failed"') ||
      serialized.includes('"needs_review"')
    )
      continue;
    await env.MEDIA_BUCKET.delete(item.object_key);
    await db.update(`media_assets?id=eq.${item.id}`, {
      upload_status: "deleted",
      deleted_at: new Date().toISOString(),
    });
  }
}

async function abortStaleUploads(env: Env) {
  const db = new SupabaseRest(env);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  const rows = await db.select<
    Array<{ id: string; object_key: string; upload_id: string | null }>
  >(
    `media_assets?upload_status=eq.uploading&created_at=lt.${cutoff}&select=id,object_key,upload_id&limit=100`,
  );
  for (const item of rows) {
    if (item.upload_id)
      await env.MEDIA_BUCKET.resumeMultipartUpload(
        item.object_key,
        item.upload_id,
      ).abort();
    else await env.MEDIA_BUCKET.delete(item.object_key);
    await db.update(`media_assets?id=eq.${item.id}`, {
      upload_status: "aborted",
      upload_id: null,
    });
  }
}

export default worker;
