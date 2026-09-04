import { redactSecrets } from "@scheduler/shared";

import { SupabaseRest } from "./database";
import type { Env } from "./env";

export async function sendFailureEmailOnce(
  env: Env,
  input: {
    ownerId: string;
    targetId: string;
    postTitle: string;
    platform: string;
    scheduledAt: string;
    status: "failed" | "needs_review";
    safeMessage: string;
    attempt: number;
  },
): Promise<boolean> {
  const db = new SupabaseRest(env);
  const deduplicationKey = `failure:${input.targetId}:attempt:${input.attempt}`;
  const rows = await db.insert<Array<{ id: string }>>(
    "email_events?on_conflict=deduplication_key",
    {
      owner_id: input.ownerId,
      post_target_id: input.targetId,
      event_type:
        input.status === "failed" ? "target_failed" : "target_needs_review",
      deduplication_key: deduplicationKey,
    },
    "resolution=ignore-duplicates,return=representation",
  );
  if (!rows.length) return false;
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
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": deduplicationKey,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [env.NOTIFICATION_EMAIL],
      subject: `${input.platform} scheduled post ${ambiguous ? "needs review" : "failed"}`,
      html,
    }),
  });
  const result = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
  };
  await db.update(`email_events?id=eq.${rows[0]!.id}`, {
    status: response.ok ? "sent" : "failed",
    ...(result.id ? { provider_message_id: result.id } : {}),
    ...(!response.ok
      ? { safe_error_message: "Resend rejected the notification request" }
      : {}),
    ...(response.ok ? { sent_at: new Date().toISOString() } : {}),
  });
  return response.ok;
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
