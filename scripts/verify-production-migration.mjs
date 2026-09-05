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

console.log(
  "Verified claim_stale_targets service-role access and notification reconciliation schema with non-mutating preflights.",
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
