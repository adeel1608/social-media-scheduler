import { readdir, readFile } from "node:fs/promises";

const directory = "supabase/migrations";
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".sql"))
  .sort();
if (!files.length) throw new Error("No Supabase migrations found");
const sql = (
  await Promise.all(
    files.map((file) => readFile(`${directory}/${file}`, "utf8")),
  )
)
  .join("\n")
  .toLowerCase();
const requiredTables = [
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
];
const missingTables = requiredTables.filter(
  (table) => !sql.includes(`create table public.${table}`),
);
const requirements = {
  "atomic claim function":
    sql.includes("function public.claim_due_targets") &&
    sql.includes("for update skip locked"),
  "row level security": requiredTables.every((table) =>
    sql.includes(`alter table public.${table} enable row level security`),
  ),
  "owner policy": sql.includes("app_private.is_owner"),
  "idempotency uniqueness": sql.includes(
    "idempotency_key text not null unique",
  ),
  "manual retry": sql.includes("function public.begin_manual_retry"),
  "server pagination indexes": sql.includes("post_targets_owner_status_idx"),
};
if (missingTables.length || Object.values(requirements).includes(false)) {
  console.error({ missingTables, requirements });
  process.exit(1);
}
console.log(
  `Validated ${files.length} ordered migration files, ${requiredTables.length} required tables, RLS, claims, indexes, and idempotency.`,
);
