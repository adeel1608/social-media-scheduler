import { redactSecrets } from "@scheduler/shared";

import { SupabaseRest } from "./database";
import type { Env } from "./env";

interface FailureNotificationInput {
  ownerId: string;
  targetId: string;
  postTitle: string;
  platform: string;
  scheduledAt: string;
  status: "failed" | "needs_review";
  safeMessage: string;
  attempt: number;
}

interface EmailEventRow {
  id: string;
  status: "pending" | "sent" | "failed";
  delivery_attempts?: number;
}

interface PendingEmailEventRow extends EmailEventRow {
  deduplication_key: string;
  event_type: "target_failed" | "target_needs_review";
  post_targets: {
    id: string;
    owner_id: string;
    platform: string;
    scheduled_at_utc: string;
    last_error_message: string | null;
    posts: { title: string } | null;
  };
}

function deduplicationKey(input: FailureNotificationInput): string {
  return `failure:${input.targetId}:attempt:${input.attempt}`;
}

export async function sendFailureEmailOnce(
  env: Env,
  input: FailureNotificationInput,
): Promise<boolean> {
  const db = new SupabaseRest(env);
  const key = deduplicationKey(input);
  const inserted = await db.insert<EmailEventRow[]>(
    "email_events?on_conflict=deduplication_key",
    {
      owner_id: input.ownerId,
      post_target_id: input.targetId,
      event_type:
        input.status === "failed" ? "target_failed" : "target_needs_review",
      deduplication_key: key,
    },
    "resolution=ignore-duplicates,return=representation",
  );
  const event =
    inserted[0] ??
    (
      await db.select<EmailEventRow[]>(
        `email_events?deduplication_key=eq.${encodeURIComponent(key)}&select=id,status,delivery_attempts&limit=1`,
      )
    )[0];
  if (!event || event.status === "sent") return false;
  return deliverFailureEmail(env, db, event, key, input);
}

export async function retryFailedNotifications(
  env: Env,
  limit = 25,
): Promise<{ attempted: number; sent: number }> {
  const db = new SupabaseRest(env);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const events = await db.select<PendingEmailEventRow[]>(
    `email_events?status=in.(pending,failed)&next_attempt_at=lte.now()&select=id,status,delivery_attempts,deduplication_key,event_type,post_targets!inner(id,owner_id,platform,scheduled_at_utc,last_error_message,posts(title))&order=next_attempt_at.asc,created_at.asc&limit=${boundedLimit}`,
  );
  let sent = 0;
  for (const event of events) {
    const target = event.post_targets;
    const attemptMatch = /:attempt:(\d+)$/.exec(event.deduplication_key);
    const delivered = await deliverFailureEmail(
      env,
      db,
      event,
      event.deduplication_key,
      {
        ownerId: target.owner_id,
        targetId: target.id,
        postTitle: target.posts?.title ?? target.id,
        platform: target.platform,
        scheduledAt: target.scheduled_at_utc,
        status:
          event.event_type === "target_needs_review"
            ? "needs_review"
            : "failed",
        safeMessage:
          target.last_error_message ??
          "The provider result requires operator attention.",
        attempt: Number(attemptMatch?.[1] ?? 1),
      },
    );
    if (delivered) sent += 1;
  }
  return { attempted: events.length, sent };
}

async function deliverFailureEmail(
  env: Env,
  db: SupabaseRest,
  event: EmailEventRow,
  key: string,
  input: FailureNotificationInput,
): Promise<boolean> {
  const attempt = Number(event.delivery_attempts ?? 0) + 1;
  const now = new Date();
  const retryDelaySeconds = Math.min(5 * 2 ** Math.min(attempt - 1, 10), 3600);
  const claimed = await db.update<Array<{ id: string }>>(
    `email_events?id=eq.${event.id}&status=neq.sent&next_attempt_at=lte.now()`,
    {
      status: "pending",
      delivery_attempts: attempt,
      last_attempt_at: now.toISOString(),
      next_attempt_at: new Date(
        now.getTime() + retryDelaySeconds * 1_000,
      ).toISOString(),
    },
  );
  if (!claimed.length) return false;
  const safeMessage = String(redactSecrets(input.safeMessage))
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .slice(0, 500);
  const ambiguous = input.status === "needs_review";
  const html = `
    <h1>Scheduled post ${ambiguous ? "needs review" : "failed"}</h1>
    <p><strong>Post:</strong> ${escapeHtml(input.postTitle || input.targetId)}</p>
    <p><strong>Platform:</strong> ${escapeHtml(input.platform)}</p>
    <p><strong>Scheduled:</strong> ${escapeHtml(input.scheduledAt)}</p>
    <p><strong>Failure recorded:</strong> ${escapeHtml(new Date().toISOString())}</p>
    <p><strong>Status:</strong> ${ambiguous ? "Ambiguous — do not retry until checked on-platform." : "Definitely failed"}</p>
    <p><strong>Safe error:</strong> ${escapeHtml(safeMessage)}</p>
    <p><a href="${escapeHtml(env.APP_URL)}/failed">Open failed posts</a></p>
    <p>${ambiguous ? "Review the platform first. If no content exists, resolve the item before retrying." : "Open the failed item and choose Manual retry when ready."}</p>`;
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [env.NOTIFICATION_EMAIL],
        subject: `${input.platform} scheduled post ${ambiguous ? "needs review" : "failed"}`,
        html,
      }),
    });
  } catch {
    await markDeliveryFailed(
      db,
      event.id,
      "Notification delivery could not be confirmed",
    );
    return false;
  }
  const result = (await response.json().catch(() => ({}))) as {
    id?: string;
  };
  await db.update(`email_events?id=eq.${event.id}`, {
    status: response.ok ? "sent" : "failed",
    ...(result.id ? { provider_message_id: result.id } : {}),
    ...(!response.ok
      ? { safe_error_message: "Resend rejected the notification request" }
      : { safe_error_message: null }),
    ...(response.ok ? { sent_at: new Date().toISOString() } : {}),
  });
  return response.ok;
}

function markDeliveryFailed(
  db: SupabaseRest,
  eventId: string,
  message: string,
) {
  return db.update(`email_events?id=eq.${eventId}`, {
    status: "failed",
    safe_error_message: message,
  });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ]!,
  );
}
