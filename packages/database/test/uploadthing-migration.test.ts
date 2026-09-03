import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationPath =
  "supabase/migrations/202609030003_uploadthing_storage.sql";

describe("UploadThing quota migration", () => {
  it("reserves below a hard 1.8 GiB cap while holding the installation row lock", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    const lock = sql.indexOf("for update");
    const sum = sql.indexOf("select coalesce(sum(size_bytes), 0)");
    const insert = sql.indexOf("insert into public.media_assets");

    expect(sql).toContain("active_media_limit constant bigint := 1932735283");
    expect(sql).toContain("used_bytes + p_size_bytes > active_media_limit");
    expect(sql).toContain("upload_status in ('uploading', 'complete')");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(sum);
    expect(sum).toBeLessThan(insert);
  });

  it("keeps reservations counted until bounded cleanup confirms provider absence", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("now() + interval '24 hours'");
    expect(sql).not.toContain("reservation_expires_at > now()");
    expect(sql).toContain("provider_deleted_at");
    expect(sql).toContain("deletion_status");
  });

  it("makes callback completion atomic and idempotent", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    const functionSql = sql.slice(sql.indexOf("complete_uploadthing_media"));
    expect(functionSql).toContain("for update");
    expect(functionSql).toContain("return 'already_complete'");
    expect(functionSql).toContain("return 'expired'");
    expect(functionSql).toContain("provider_file_key = p_provider_file_key");
  });

  it("does not release a mismatched callback reservation before provider cleanup", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    const functionSql = sql.slice(sql.indexOf("complete_uploadthing_media"));
    const mismatchBlock = functionSql.slice(
      functionSql.indexOf("media.size_bytes <> p_size_bytes"),
      functionSql.indexOf("return 'mismatch'") + "return 'mismatch'".length,
    );

    expect(mismatchBlock).toContain(
      "deletion_blocked_reason = 'upload_metadata_mismatch'",
    );
    expect(mismatchBlock).not.toContain("upload_status = 'aborted'");
  });
});
