import { SupabaseRest } from "./database";
import { metaReviewerConfiguration, type Env } from "./env";
import { requireReviewerAuthorization } from "./review-authorization";

export class PublicationFenceLostError extends Error {
  constructor() {
    super("Publication fence is no longer owned.");
  }
}

export interface PublicationSnapshot {
  id: string;
  owner_id: string;
  lease_owner?: string | null;
  row_version?: number;
  status: string;
  authorization_context?: "owner" | "meta_review";
  authorization_generation?: string | null;
  platform_upload_state?: Record<string, unknown> | null;
  connected_accounts: { id?: string; credential_version?: number };
}

export function publicationAuthorizationArguments(env: Env) {
  const reviewer = metaReviewerConfiguration(env);
  return {
    p_owner_email: env.OWNER_EMAIL?.trim().toLowerCase() ?? "",
    p_live_enabled: env.LIVE_TEST_CONFIRM === "true",
    p_review_enabled: reviewer.enabled && reviewer.configured,
    p_reviewer_id: reviewer.configured ? reviewer.userId : null,
    p_reviewer_email: reviewer.configured ? reviewer.email : null,
  };
}

/** The request-scoped snapshot is advanced only by a successful database CAS.
 * A stale worker cannot adopt a newer version by reloading or retrying a write.
 */
export class PublicationDatabase extends SupabaseRest {
  private version: number;
  private status: string;
  private state: Record<string, unknown> | null;
  constructor(
    private readonly publicationEnv: Env,
    private readonly database: SupabaseRest,
    private readonly snapshot: PublicationSnapshot,
    private readonly leaseOwner: string,
  ) {
    super(publicationEnv);
    if (
      !Number.isSafeInteger(snapshot.row_version) ||
      snapshot.lease_owner !== leaseOwner
    )
      throw new PublicationFenceLostError();
    this.version = snapshot.row_version!;
    this.status = snapshot.status;
    this.state = structuredClone(snapshot.platform_upload_state ?? null);
  }

  async assertCurrent(): Promise<void> {
    await this.update(`post_targets?id=eq.${this.snapshot.id}`, {});
  }

  override async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (path.startsWith("post_targets") && init.method && init.method !== "GET")
      throw new PublicationFenceLostError();
    // Calls not altering a target (attempt records/retention) retain their
    // existing scoped paths. All provider-deciding target writes use update().
    return this.database.request<T>(path, init);
  }

  override async update<T>(path: string, data: unknown): Promise<T> {
    const credentials = path.startsWith("connected_accounts?");
    if (!path.startsWith("post_targets?") && !credentials)
      return this.database.update<T>(path, data);
    const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    const expectedId = credentials
      ? this.snapshot.connected_accounts.id
      : this.snapshot.id;
    if (!expectedId || query.get("id") !== `eq.${expectedId}`)
      throw new PublicationFenceLostError();
    if (this.snapshot.authorization_context === "meta_review") {
      if (!this.snapshot.authorization_generation)
        throw new PublicationFenceLostError();
      await requireReviewerAuthorization(
        this.publicationEnv,
        this.snapshot.owner_id,
        this.snapshot.authorization_generation,
      );
    }
    const result = await this.database.rpc<
      | Array<PublicationSnapshot>
      | { target: PublicationSnapshot; credential_version: number }
      | null
    >(
      credentials
        ? "refresh_publication_credentials"
        : "transition_publication_target",
      {
        p_target_id: this.snapshot.id,
        p_lease_owner: this.leaseOwner,
        p_row_version: this.version,
        p_expected_status: this.status,
        p_expected_upload_state: this.state,
        p_context: this.snapshot.authorization_context ?? "owner",
        p_authorization_generation:
          this.snapshot.authorization_generation ?? null,
        p_account_version:
          this.snapshot.connected_accounts.credential_version ?? -1,
        p_patch: data,
        ...publicationAuthorizationArguments(this.publicationEnv),
      },
    );
    const rows = Array.isArray(result) ? result : result ? [result.target] : [];
    if (credentials && result && !Array.isArray(result)) {
      if (!Number.isSafeInteger(result.credential_version))
        throw new PublicationFenceLostError();
      this.snapshot.connected_accounts.credential_version =
        result.credential_version;
    }
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(rows[0]!.row_version) ||
      rows[0]!.row_version! <= this.version
    )
      throw new PublicationFenceLostError();
    this.version = rows[0]!.row_version!;
    this.status = rows[0]!.status;
    this.state = structuredClone(rows[0]!.platform_upload_state ?? null);
    return rows as T;
  }
}
