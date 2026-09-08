import { boundedFetch } from "@scheduler/shared";

import { SupabaseRest } from "./database";
import { metaReviewerConfiguration, type Env } from "./env";

export class ReviewerAuthorizationError extends Error {
  constructor() {
    super("Reviewer authorization is unavailable or revoked.");
  }
}

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No caching: every privileged boundary checks Auth and the durable grant.
 * Never expose the admin response, identity bindings or server key in errors.
 */
export async function requireReviewerAuthorization(
  env: Env,
  userId: string,
  expectedGeneration?: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  try {
    const configured = metaReviewerConfiguration(env);
    if (
      !configured.enabled ||
      !configured.configured ||
      configured.userId !== userId
    )
      throw new ReviewerAuthorizationError();
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    const base = env.SUPABASE_URL.replace(/\/$/, "");
    const response = await boundedFetch(
      fetcher,
      `${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { headers },
    );
    if (!response.ok) throw new ReviewerAuthorizationError();
    const user = (await response.json()) as Record<string, unknown>;
    if (
      user.id !== userId ||
      typeof user.email !== "string" ||
      user.email.toLowerCase() !== configured.email ||
      user.deleted_at ||
      user.is_anonymous === true ||
      typeof user.email_confirmed_at !== "string" ||
      !Number.isFinite(Date.parse(user.email_confirmed_at)) ||
      (user.banned_until != null &&
        (typeof user.banned_until !== "string" ||
          !Number.isFinite(Date.parse(user.banned_until)) ||
          Date.parse(user.banned_until) > Date.now()))
    )
      throw new ReviewerAuthorizationError();
    const grantResponse = await boundedFetch(
      fetcher,
      `${base}/rest/v1/rpc/current_meta_review_authorization`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ p_user_id: userId, p_email: configured.email }),
      },
    );
    if (!grantResponse.ok) throw new ReviewerAuthorizationError();
    const grant = (await grantResponse.json()) as {
      generation?: unknown;
    } | null;
    if (
      !grant ||
      typeof grant.generation !== "string" ||
      !uuid.test(grant.generation) ||
      (expectedGeneration !== undefined &&
        grant.generation !== expectedGeneration)
    )
      throw new ReviewerAuthorizationError();
    const current = metaReviewerConfiguration(env);
    if (
      !current.enabled ||
      !current.configured ||
      current.userId !== userId ||
      current.email !== configured.email
    )
      throw new ReviewerAuthorizationError();
    return grant.generation;
  } catch {
    throw new ReviewerAuthorizationError();
  }
}

/** Request-scoped service client. It cannot outlive/rebind its authorization. */
export class ReviewerDatabase extends SupabaseRest {
  constructor(
    private readonly reviewEnv: Env,
    private readonly reviewerId: string,
    private readonly generation: string,
  ) {
    super(reviewEnv);
  }
  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await requireReviewerAuthorization(
      this.reviewEnv,
      this.reviewerId,
      this.generation,
    );
    const table = path.split("?")[0] ?? "";
    if (
      [
        "connected_accounts",
        "posts",
        "post_targets",
        "media_assets",
        "analytics_snapshots",
      ].includes(table) &&
      (init.method === undefined ||
        ["GET", "PATCH", "DELETE"].includes(init.method))
    ) {
      path += `${path.includes("?") ? "&" : "?"}authorization_generation=eq.${encodeURIComponent(this.generation)}`;
    }
    return super.request<T>(path, init);
  }
}
