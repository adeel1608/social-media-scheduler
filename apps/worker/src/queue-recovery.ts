import type { Platform } from "@scheduler/shared";

import { SupabaseRest } from "./database";
import type { Env, QueueJob } from "./env";
import { logWorkerError } from "./logging";
import { metaReviewerConfiguration } from "./env";
import { requireReviewerAuthorization } from "./review-authorization";

interface StaleTarget {
  id: string;
  authorization_generation?: string | null;
  platform: Platform;
  status: "publishing" | "processing";
  platform_upload_state: Record<string, unknown> | null;
}

export function recoveryModeForTarget(target: {
  status: string;
  platform_upload_state?: Record<string, unknown> | null;
}): QueueJob["mode"] {
  const state = target.platform_upload_state;
  if (state?.encryptedUrl && state.uploadComplete !== true) return "upload";
  if (state?.statusHandle || target.status === "processing") return "poll";
  return "publish";
}

export async function recoverStaleQueueTargets(
  env: Env,
  db: SupabaseRest = new SupabaseRest(env),
): Promise<number> {
  const workerId = `stale-recovery:${crypto.randomUUID()}`;
  const targets = await db.rpc<StaleTarget[]>("claim_stale_targets", {
    p_worker_id: workerId,
    p_limit: 100,
    p_stale_seconds: 900,
    p_lease_seconds: 300,
  });
  const reviewer = metaReviewerConfiguration(env);
  if (reviewer.enabled && reviewer.configured) {
    try {
      const generation = await requireReviewerAuthorization(
        env,
        reviewer.userId,
      );
      targets.push(
        ...(await db.rpc<StaleTarget[]>("claim_stale_meta_review_targets", {
          p_worker_id: workerId,
          p_reviewer_id: reviewer.userId,
          p_reviewer_email: reviewer.email,
          p_generation: generation,
          p_limit: 100,
          p_stale_seconds: 900,
          p_lease_seconds: 300,
        })),
      );
    } catch {
      logWorkerError("reviewer_stale_recovery_skipped");
    }
  }
  let dispatched = 0;
  for (const target of targets) {
    const mode = recoveryModeForTarget(target);
    try {
      await env.PUBLISH_QUEUE.send({
        targetId: target.id,
        ...(target.authorization_generation
          ? { authorizationGeneration: target.authorization_generation }
          : {}),
        mode,
        requestedAt: new Date().toISOString(),
      });
      dispatched += 1;
    } catch {
      logWorkerError("stale_queue_dispatch_failed", {
        targetId: target.id,
        provider: target.platform,
        state: target.status,
        classification: "retryable_infrastructure",
      });
    } finally {
      await db.update(
        `post_targets?id=eq.${encodeURIComponent(target.id)}&lease_owner=eq.${encodeURIComponent(workerId)}`,
        { lease_owner: null, lease_expires_at: null },
      );
    }
  }
  return dispatched;
}
