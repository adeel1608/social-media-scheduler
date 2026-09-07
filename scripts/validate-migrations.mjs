import { readdir, readFile } from "node:fs/promises";

const directory = "supabase/migrations";
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".sql"))
  .sort();
if (!files.length) throw new Error("No Supabase migrations found");
const migrationContents = await Promise.all(
  files.map((file) => readFile(`${directory}/${file}`, "utf8")),
);
const sql = migrationContents.join("\n").toLowerCase();
const phase2bPreflightFile = "202609050004_phase_2b_preflight.sql";
const phase2bPreflightSql = files.includes(phase2bPreflightFile)
  ? migrationContents[files.indexOf(phase2bPreflightFile)].toLowerCase()
  : "";
const metaReviewMigrationFile = "202609060001_meta_review_access.sql";
const metaReviewMigrationSql = files.includes(metaReviewMigrationFile)
  ? migrationContents[files.indexOf(metaReviewMigrationFile)].toLowerCase()
  : "";
const oauthCompletionMigrationFile =
  "202609070007_authenticated_oauth_completion.sql";
const oauthCompletionMigrationSql = files.includes(oauthCompletionMigrationFile)
  ? migrationContents[files.indexOf(oauthCompletionMigrationFile)].toLowerCase()
  : "";
const mediaLeastPrivilegeMigrationFile =
  "202609070008_media_least_privilege.sql";
const mediaLeastPrivilegeMigrationSql = files.includes(
  mediaLeastPrivilegeMigrationFile,
)
  ? migrationContents[
      files.indexOf(mediaLeastPrivilegeMigrationFile)
    ].toLowerCase()
  : "";
const requiredTables = [
  "installation_settings",
  "connected_accounts",
  "oauth_states",
  "media_assets",
  "posts",
  "post_media",
  "post_targets",
  "publish_attempts",
  "analytics_snapshots",
  "email_events",
  "audit_log",
  "rate_limit_buckets",
  "account_disconnect_transactions",
];
const missingTables = requiredTables.filter(
  (table) =>
    !sql.includes(`create table public.${table}`) &&
    !sql.includes(`create table if not exists public.${table}`),
);
const requirements = {
  "atomic claim function":
    sql.includes("function public.claim_due_targets") &&
    sql.includes("for update skip locked"),
  "stale publishing recovery":
    sql.includes("function public.claim_stale_targets") &&
    sql.includes("candidate.status in ('publishing', 'processing')") &&
    sql.includes(
      "grant execute on function public.claim_stale_targets(text, integer, integer, integer)",
    ) &&
    sql.includes("limit greatest(0, least(p_limit, 500))"),
  "row level security": requiredTables.every((table) =>
    sql.includes(`alter table public.${table} enable row level security`),
  ),
  "owner policy": sql.includes("app_private.is_owner"),
  "idempotency uniqueness": sql.includes(
    "idempotency_key text not null unique",
  ),
  "manual retry": sql.includes("function public.begin_manual_retry"),
  "server pagination indexes": sql.includes("post_targets_owner_status_idx"),
  "atomic UploadThing quota reservation":
    sql.includes("function public.reserve_uploadthing_media") &&
    sql.includes("active_media_limit constant bigint := 1932735283") &&
    sql.includes("from public.installation_settings settings") &&
    sql.includes("for update"),
  "idempotent UploadThing completion":
    sql.includes("function public.complete_uploadthing_media") &&
    sql.includes("return 'already_complete'"),
  "qualified audit digest": sql.includes(
    "encode(extensions.digest(owner_email, 'sha256'), 'hex')",
  ),
  "automatic RLS helper RPC access revoked":
    sql.includes("to_regprocedure('public.rls_auto_enable()')") &&
    sql.includes(
      "revoke all on function public.rls_auto_enable() from public, anon, authenticated",
    ),
  "durable notification reconciliation":
    sql.includes("function app_private.enqueue_target_failure_email()") &&
    sql.includes("post_targets_enqueue_failure_email") &&
    sql.includes("on conflict (deduplication_key) do nothing") &&
    sql.includes("email_events_delivery_retry_idx") &&
    sql.includes("next_attempt_at"),
  "durable disconnect recovery":
    sql.includes("function public.begin_account_disconnect") &&
    sql.includes(
      "function public.mark_account_disconnect_revocation_started",
    ) &&
    sql.includes("function public.record_account_disconnect_revocation") &&
    sql.includes("function public.complete_account_disconnect") &&
    sql.includes("account_disconnect_owner_select") &&
    sql.includes("provider_request_sent_at") &&
    sql.includes("connected_accounts_clear_disconnect_on_reconnect"),
  "role-authorized Phase 2B preflight":
    phase2bPreflightSql.includes(
      "create or replace function public.verify_phase_2b_schema()",
    ) &&
    phase2bPreflightSql.includes("stable") &&
    phase2bPreflightSql.includes(
      "revoke all on function public.verify_phase_2b_schema()",
    ) &&
    phase2bPreflightSql.includes("from public, anon, authenticated") &&
    phase2bPreflightSql.includes(
      "grant execute on function public.verify_phase_2b_schema()",
    ) &&
    phase2bPreflightSql.includes("to service_role") &&
    !phase2bPreflightSql.includes("request.jwt.claim.role"),
  "isolated Meta review workspace":
    metaReviewMigrationSql.includes("authorization_context") &&
    metaReviewMigrationSql.includes(
      "function public.create_meta_review_post",
    ) &&
    metaReviewMigrationSql.includes(
      "function public.reserve_meta_review_media",
    ) &&
    metaReviewMigrationSql.includes(
      "function public.verify_meta_review_schema",
    ) &&
    metaReviewMigrationSql.includes("from public, anon, authenticated") &&
    metaReviewMigrationSql.includes("to service_role"),
  "authenticated OAuth completion":
    oauthCompletionMigrationSql.includes(
      "function public.record_bound_oauth_callback",
    ) &&
    oauthCompletionMigrationSql.includes(
      "function public.consume_oauth_completion",
    ) &&
    oauthCompletionMigrationSql.includes(
      "function public.cancel_pending_oauth",
    ) &&
    oauthCompletionMigrationSql.includes(
      "function public.expire_pending_oauth_states",
    ) &&
    oauthCompletionMigrationSql.includes("pending_authorization_code") &&
    oauthCompletionMigrationSql.includes("pending_completion_handle_hash") &&
    oauthCompletionMigrationSql.includes(
      "from public, anon, authenticated, service_role",
    ),
  "media least privilege":
    mediaLeastPrivilegeMigrationSql.includes(
      "drop policy if exists media_assets_owner_all",
    ) &&
    mediaLeastPrivilegeMigrationSql.includes(
      "create policy media_assets_owner_select",
    ) &&
    mediaLeastPrivilegeMigrationSql.includes(
      "revoke insert, update, delete, truncate, references, trigger",
    ) &&
    mediaLeastPrivilegeMigrationSql.includes(
      "from public, anon, authenticated",
    ) &&
    mediaLeastPrivilegeMigrationSql.includes(
      "grant select on table public.media_assets to authenticated",
    ) &&
    mediaLeastPrivilegeMigrationSql.includes(
      "not has_table_privilege('authenticated', 'public.media_assets', 'update')",
    ),
};
if (missingTables.length || Object.values(requirements).includes(false)) {
  console.error({ missingTables, requirements });
  process.exit(1);
}
console.log(
  `Validated ${files.length} ordered migration files, ${requiredTables.length} required tables, RLS, claims, indexes, and idempotency.`,
);
