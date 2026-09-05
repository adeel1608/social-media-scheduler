const urlValue = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!urlValue || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for migration verification",
  );
}

const baseUrl = new URL(urlValue);
if (baseUrl.protocol !== "https:") {
  throw new Error("Production Supabase migration verification requires HTTPS");
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};
let response;
try {
  response = await boundedFetch(
    new URL("/rest/v1/rpc/claim_stale_targets", baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_worker_id: "deployment-preflight",
        p_limit: 0,
        p_stale_seconds: 900,
        p_lease_seconds: 300,
      }),
    },
  );
} catch {
  throw new Error("Production migration verification request failed");
}

if (!response.ok) {
  throw new Error(
    `claim_stale_targets is missing or inaccessible to service_role (HTTP ${response.status})`,
  );
}

const result = await response.json().catch(() => null);
if (!Array.isArray(result) || result.length !== 0) {
  throw new Error(
    "claim_stale_targets deployment preflight was not non-mutating",
  );
}

let notificationSchemaResponse;
try {
  notificationSchemaResponse = await boundedFetch(
    new URL(
      "/rest/v1/email_events?select=delivery_attempts,next_attempt_at&limit=0",
      baseUrl,
    ),
    { headers },
  );
} catch {
  throw new Error("Notification migration verification request failed");
}
if (!notificationSchemaResponse.ok) {
  throw new Error(
    `notification reconciliation schema is missing or inaccessible to service_role (HTTP ${notificationSchemaResponse.status})`,
  );
}

let phase2bResponse;
try {
  phase2bResponse = await boundedFetch(
    new URL("/rest/v1/rpc/verify_phase_2b_schema", baseUrl),
    { method: "POST", headers, body: "{}" },
  );
} catch {
  throw new Error("Phase 2B migration verification request failed");
}
if (!phase2bResponse.ok) {
  throw new Error(
    `Phase 2B schema is missing or inaccessible to service_role (HTTP ${phase2bResponse.status})`,
  );
}
const phase2bResult = await phase2bResponse.json().catch(() => null);
if (phase2bResult?.ready !== true) {
  throw new Error("Phase 2B schema preflight did not report ready");
}

console.log(
  "Verified queue recovery, notification reconciliation, and Phase 2B schemas with non-mutating service-role preflights.",
);

async function boundedFetch(url, init) {
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
