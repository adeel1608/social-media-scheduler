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
      "post_targets",
      "publish_attempts",
      "analytics_snapshots",
      "email_events",
      "audit_log",
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
  });

  it("enforces independent target uniqueness and email deduplication", () => {
    expect(sql).toContain("unique (post_id, platform)");
    expect(sql).toContain("deduplication_key text not null unique");
  });

  it("persists per-target media, safe manual retries, and retention gates", () => {
    expect(sql).toContain("selected_media_ids uuid[]");
    expect(sql).toContain("target media must be selected from post media");
    expect(sql).toContain("publish_request_sent_at = null");
    expect(sql).toContain("deletion_blocked_reason");
    expect(sql).toContain("delete_installation_data");
  });
});
