import { readFile } from "node:fs/promises";

const env = { ...process.env, ...(await loadDotEnv()) };

const checks = [
  ["APP_URL", isUrl],
  ["WORKER_PUBLIC_URL", isUrl],
  ["OWNER_EMAIL", isEmail],
  ["NOTIFICATION_EMAIL", isEmail],
  ["TIMEZONE", isTimeZone],
  ["SUPABASE_URL", isHttpsUrl],
  ["SUPABASE_ANON_KEY", isPresent],
  ["SUPABASE_SERVICE_ROLE_KEY", isPresent],
  ["TOKEN_ENCRYPTION_KEY", isEncryptionKey],
  ["CLOUDFLARE_ACCOUNT_ID", isIdentifier],
  ["CLOUDFLARE_API_TOKEN", isPresent],
  ["UPLOADTHING_TOKEN", isUploadThingToken],
  ["RESEND_API_KEY", (value) => /^re_/.test(value)],
  ["RESEND_FROM", isPresent],
  ["META_APP_ID", isPresent],
  ["META_APP_SECRET", isPresent],
  ["META_REDIRECT_URI", isUrl],
  ["TIKTOK_CLIENT_KEY", isPresent],
  ["TIKTOK_CLIENT_SECRET", isPresent],
  ["TIKTOK_REDIRECT_URI", isUrl],
  ["GOOGLE_CLIENT_ID", isPresent],
  ["GOOGLE_CLIENT_SECRET", isPresent],
  ["GOOGLE_REDIRECT_URI", isUrl],
];

console.log("Postline setup doctor (values are never displayed)\n");
let missing = 0;
let invalid = 0;
for (const [name, validator] of checks) {
  const value = env[name] ?? "";
  const placeholder = /replace-|your-|example\.com/i.test(value);
  if (!value || placeholder) {
    console.log(`MISSING             ${name}`);
    missing += 1;
  } else if (!validator(value)) {
    console.log(`INVALID FORMAT      ${name}`);
    invalid += 1;
  } else {
    console.log(`PRESENT             ${name}`);
  }
}

if (
  env.SUPABASE_URL &&
  env.SUPABASE_ANON_KEY &&
  !/your-project/.test(env.SUPABASE_URL)
) {
  try {
    const response = await fetch(
      `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/health`,
      {
        headers: { apikey: env.SUPABASE_ANON_KEY },
        signal: AbortSignal.timeout(8_000),
      },
    );
    console.log(
      `${response.ok ? "CONNECTION SUCCESS" : "CONNECTION FAILED "} SUPABASE`,
    );
  } catch {
    console.log("CONNECTION FAILED  SUPABASE");
  }
}

for (const [name, label] of [
  ["META_APP_REVIEW_APPROVED", "Instagram Meta review"],
  ["TIKTOK_CONTENT_POSTING_AUDITED", "TikTok public-post audit"],
  ["YOUTUBE_API_AUDIT_APPROVED", "YouTube upload audit"],
]) {
  console.log(
    `${env[name] === "true" ? "APPROVAL CONFIRMED " : "HUMAN APPROVAL PENDING"} ${label}`,
  );
}

const approvalsReady = [
  "META_APP_REVIEW_APPROVED",
  "TIKTOK_CONTENT_POSTING_AUDITED",
  "YOUTUBE_API_AUDIT_APPROVED",
].every((name) => env[name] === "true");
const liveReady =
  missing === 0 &&
  invalid === 0 &&
  approvalsReady &&
  env.LIVE_TEST_CONFIRM === "true";
console.log(
  `\n${liveReady ? "LIVE PUBLISHING READY" : "LIVE PUBLISHING NOT READY"}`,
);
console.log(
  "Infrastructure quotas and official platform API limits always apply.",
);
process.exitCode = missing || invalid ? 1 : 0;

async function loadDotEnv() {
  try {
    const text = await readFile(".env", "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter(
          (line) =>
            line && !line.trimStart().startsWith("#") && line.includes("="),
        )
        .map((line) => {
          const index = line.indexOf("=");
          return [
            line.slice(0, index).trim(),
            line
              .slice(index + 1)
              .trim()
              .replace(/^['"]|['"]$/g, ""),
          ];
        }),
    );
  } catch {
    return {};
  }
}

function isPresent(value) {
  return value.trim().length >= 8;
}
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function isUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
function isTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function isIdentifier(value) {
  return /^[a-zA-Z0-9_-]{3,128}$/.test(value);
}
function isEncryptionKey(value) {
  try {
    return Buffer.from(value, "base64").byteLength === 32;
  } catch {
    return false;
  }
}
function isUploadThingToken(value) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(
      Buffer.from(normalized, "base64").toString("utf8"),
    );
    return (
      typeof parsed.appId === "string" &&
      parsed.appId.length >= 3 &&
      typeof parsed.apiKey === "string" &&
      parsed.apiKey.length >= 8 &&
      Array.isArray(parsed.regions)
    );
  } catch {
    return false;
  }
}
