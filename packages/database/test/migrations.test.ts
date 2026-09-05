import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationDirectory = resolve(process.cwd(), "supabase/migrations");
const sql = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => readFileSync(resolve(migrationDirectory, file), "utf8"))
  .join("\n")
  .toLowerCase();

describe("Supabase migrations", () => {
  it("enables RLS on every owner data table", () => {
    for (const table of [
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
    ]) {
      expect(sql).toContain(
        `alter table public.${table} enable row level security`,
      );
    }
    expect(sql).toContain("app_private.is_owner");
  });

  it("claims atomically with row locks, skip locked, and leases", () => {
    expect(sql).toContain("function public.claim_due_targets");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("lease_expires_at");
    expect(sql).toContain("grant execute on function public.claim_due_targets");
    expect(sql).toContain("function public.claim_stale_targets");
    expect(sql).toContain(
      "grant execute on function public.claim_stale_targets",
    );
    expect(sql).toContain("limit greatest(0, least(p_limit, 500))");
  });

  it("enforces independent target uniqueness and email deduplication", () => {
    expect(sql).toContain("unique (post_id, platform)");
    expect(sql).toContain("deduplication_key text not null unique");
  });

  it("persists per-target media, safe manual retries, and retention gates", () => {
    expect(sql).toContain("selected_media_ids uuid[]");
    expect(sql).toContain("target media must be selected from post media");
    expect(sql).toContain("publish_request_sent_at = null");
    expect(sql).toContain("function app_private.enqueue_target_failure_email");
    expect(sql).toContain("post_targets_enqueue_failure_email");
    expect(sql).toContain("email_events_delivery_retry_idx");
    expect(sql).toContain("next_attempt_at");
    expect(sql).toContain("deletion_blocked_reason");
    expect(sql).toContain("delete_installation_data");
    expect(sql).toContain("function public.begin_account_disconnect");
    expect(sql).toContain(
      "function public.mark_account_disconnect_revocation_started",
    );
    expect(sql).toContain("function public.complete_account_disconnect");
    expect(sql).toContain("account_disconnect_owner_select");
    expect(sql).toContain("connected_accounts_clear_disconnect_on_reconnect");
  });
});
