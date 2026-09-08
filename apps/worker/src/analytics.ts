import { decryptSecret } from "@scheduler/shared";

import { adapterFor } from "./adapters";
import { SupabaseRest } from "./database";
import { encryptionKeyResolver } from "./encryption";
import type { Env } from "./env";
import { metaReviewerConfiguration } from "./env";
import {
  ReviewerDatabase,
  requireReviewerAuthorization,
} from "./review-authorization";

interface AnalyticsSyncScope {
  authorizationContext?: "owner" | "meta_review";
  ownerId?: string;
}

export async function syncAnalyticsBatch(
  env: Env,
  limit = 10,
  scope: AnalyticsSyncScope = { authorizationContext: "owner" },
): Promise<number> {
  let db = new SupabaseRest(env);
  let generation: string | undefined;
  const authorizationContext = scope.authorizationContext ?? "owner";
  if (authorizationContext === "meta_review") {
    const reviewer = metaReviewerConfiguration(env);
    if (
      !reviewer.enabled ||
      !reviewer.configured ||
      scope.ownerId !== reviewer.userId
    ) {
      return 0;
    }
    generation = await requireReviewerAuthorization(env, reviewer.userId);
    db = new ReviewerDatabase(env, reviewer.userId, generation);
  }
  const ownerFilter = scope.ownerId
    ? `&owner_id=eq.${encodeURIComponent(scope.ownerId)}`
    : "";
  const platformFilter =
    authorizationContext === "meta_review" ? "&platform=eq.instagram" : "";
  const targets = await db.select<Array<Record<string, any>>>(
    `post_targets?status=eq.published&authorization_context=eq.${authorizationContext}${ownerFilter}${platformFilter}&remote_content_id=not.is.null&select=*,connected_accounts(*)&order=updated_at.asc&limit=${limit}`,
  );
  let synced = 0;
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 24 * 60 * 60 * 1_000);
  for (const target of targets) {
    try {
      const account = target.connected_accounts;
      if (
        !account ||
        account.owner_id !== target.owner_id ||
        account.authorization_context !== authorizationContext ||
        (authorizationContext === "meta_review" &&
          (target.platform !== "instagram" || account.platform !== "instagram"))
      ) {
        continue;
      }
      if (authorizationContext === "meta_review") {
        if (account.authorization_generation !== generation) continue;
        await requireReviewerAuthorization(env, target.owner_id, generation);
      }
      const accessToken = await decryptSecret(
        {
          ciphertext: account.encrypted_access_token,
          nonce: account.access_token_nonce,
          algorithm: "AES-GCM",
          keyVersion: account.encryption_key_version,
        },
        encryptionKeyResolver(env),
      );
      const adapter = adapterFor(target.platform, env);
      if (authorizationContext === "meta_review")
        await requireReviewerAuthorization(env, target.owner_id, generation);
      const metrics = await adapter.fetchAnalytics({
        accountId: account.remote_account_id,
        accessToken,
        remoteContentId: target.remote_content_id,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10),
      });
      await db.insert(
        "analytics_snapshots",
        {
          owner_id: target.owner_id,
          post_target_id: target.id,
          connected_account_id: account.id,
          platform: target.platform,
          authorization_generation: generation ?? null,
          period_start: start.toISOString().slice(0, 10),
          period_end: end.toISOString().slice(0, 10),
          normalized_metrics: Object.fromEntries(
            metrics.map((metric) => [metric.name, metric.value]),
          ),
          raw_metrics: Object.fromEntries(
            metrics
              .filter((metric) => metric.rawName)
              .map((metric) => [metric.rawName!, metric.value]),
          ),
          unavailable_metrics: metrics
            .filter((metric) => !metric.available)
            .map((metric) => metric.name),
        },
        "return=minimal",
      );
      await db.update(`post_targets?id=eq.${target.id}`, {
        updated_at: new Date().toISOString(),
      });
      synced += 1;
    } catch {
      // Analytics failures must not alter publish status; a later scheduled sync can try again.
    }
  }
  return synced;
}
