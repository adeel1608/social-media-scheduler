import { readFile } from "node:fs/promises";

const env = { ...process.env, ...(await loadDotEnv()) };

const checks = [
  ["VITE_APP_URL", (value) => isRuntimeOrigin(value) && value === env.APP_URL],
  [
    "VITE_API_URL",
    (value) => isRuntimeOrigin(value) && value === env.WORKER_PUBLIC_URL,
  ],
  [
    "VITE_SUPABASE_URL",
    (value) => isRuntimeOrigin(value) && value === env.SUPABASE_URL,
  ],
  [
    "VITE_SUPABASE_ANON_KEY",
    (value) => isCredential(value) && value === env.SUPABASE_ANON_KEY,
  ],
  ["VITE_TURNSTILE_SITE_KEY", isTurnstileSiteKey],
  ["VITE_DEMO_MODE", isBoolean],
  ["VITE_OPERATOR_NAME", isOperatorName],
  ["VITE_PUBLIC_CONTACT_EMAIL", isEmail],
  ["APP_URL", isRuntimeOrigin],
  ["WORKER_PUBLIC_URL", isRuntimeOrigin],
  ["OWNER_EMAIL", (value) => isEmail(value) && value === value.toLowerCase()],
  ["NOTIFICATION_EMAIL", isEmail],
  ["TIMEZONE", isTimeZone],
  ["LIVE_TEST_CONFIRM", isBoolean],
  ["ENVIRONMENT", (value) => ["development", "production"].includes(value)],
  ["SUPABASE_URL", isRuntimeOrigin],
  ["SUPABASE_ANON_KEY", isCredential],
  ["SUPABASE_SERVICE_ROLE_KEY", isCredential],
  ["TOKEN_ENCRYPTION_KEY", isEncryptionKey],
  ["TOKEN_ENCRYPTION_KEY_VERSION", isVersion],
  ["CLOUDFLARE_ACCOUNT_ID", (value) => /^[a-f0-9]{32}$/.test(value)],
  ["CLOUDFLARE_API_TOKEN", isCredential],
  ["UPLOADTHING_TOKEN", isUploadThingToken],
  ["RESEND_API_KEY", (value) => /^re_\S{8,}$/.test(value)],
  ["RESEND_FROM", isResendSender],
  ["META_APP_ID", isPresent],
  ["META_APP_SECRET", isPresent],
  ["META_GRAPH_VERSION", (value) => /^v[1-9][0-9]{0,2}\.0$/.test(value)],
  [
    "META_REDIRECT_URI",
    (value) => isExactCallback(value, "/api/oauth/instagram/callback"),
  ],
  ["META_APP_REVIEW_APPROVED", isBoolean],
  ["TIKTOK_CLIENT_KEY", isPresent],
  ["TIKTOK_CLIENT_SECRET", isPresent],
  [
    "TIKTOK_REDIRECT_URI",
    (value) => isExactCallback(value, "/api/oauth/tiktok/callback"),
  ],
  ["TIKTOK_CONTENT_POSTING_AUDITED", isBoolean],
  ["GOOGLE_CLIENT_ID", isPresent],
  ["GOOGLE_CLIENT_SECRET", isPresent],
  [
    "GOOGLE_REDIRECT_URI",
    (value) => isExactCallback(value, "/api/oauth/youtube/callback"),
  ],
  ["YOUTUBE_API_AUDIT_APPROVED", isBoolean],
];

console.log("Postline setup doctor (values are never displayed)\n");
let missing = 0;
let invalid = 0;
for (const [name, validator] of checks) {
  const value = env[name] ?? "";
  const demoPublicExample =
    env.VITE_DEMO_MODE === "true" &&
    ["VITE_OPERATOR_NAME", "VITE_PUBLIC_CONTACT_EMAIL"].includes(name);
  const placeholder =
    isPlaceholder(value) ||
    (name === "VITE_OPERATOR_NAME" && value.toLowerCase().includes("demo")) ||
    (name === "VITE_PUBLIC_CONTACT_EMAIL" && isPlaceholderContact(value));
  if (!value || (placeholder && !demoPublicExample)) {
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
  env.ENVIRONMENT === "production" &&
  env.VITE_DEMO_MODE === "false" &&
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
  if (!value || value.length > 254 || value !== value.trim()) return false;
  let atIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const code = character.charCodeAt(0);
    if (code <= 32 || code >= 127) return false;
    if (character === "@") {
      if (atIndex !== -1) return false;
      atIndex = index;
    }
  }
  if (atIndex < 1 || atIndex > 64 || atIndex === value.length - 1) return false;
  const labels = value.slice(atIndex + 1).split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (
      !label ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
      return false;
    for (const character of label) {
      const code = character.toLowerCase().charCodeAt(0);
      const isLetter = code >= 97 && code <= 122;
      const isNumber = code >= 48 && code <= 57;
      if (!isLetter && !isNumber && character !== "-") return false;
    }
  }
  return labels.at(-1).length >= 2;
}
function isOperatorName(value) {
  if (value.length < 2 || value.length > 100 || value !== value.trim())
    return false;
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}
function isPlaceholder(value) {
  const normalized = value.toLowerCase();
  return [
    "replace-",
    "your-",
    "your name",
    "operator name",
    "placeholder",
    "example.com",
    "example.net",
    "example.org",
    "example.invalid",
  ].some((part) => normalized.includes(part));
}
function isPlaceholderContact(value) {
  const normalized = value.toLowerCase();
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return (
    normalized.startsWith("demo@") ||
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid")
  );
}
function isRuntimeOrigin(value) {
  try {
    const url = new URL(value);
    const localHttp =
      env.ENVIRONMENT === "development" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (
      (url.protocol === "https:" || localHttp) &&
      value === url.origin &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      (env.ENVIRONMENT !== "production" || !url.port)
    );
  } catch {
    return false;
  }
}

function isExactCallback(value, path) {
  try {
    const workerUrl = env.WORKER_PUBLIC_URL;
    if (!isRuntimeOrigin(workerUrl)) return false;
    const url = new URL(value);
    return (
      value === new URL(path, workerUrl).href &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
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
function isCredential(value) {
  return value.length >= 20 && value.length <= 4096 && !/\s/.test(value);
}
function isTurnstileSiteKey(value) {
  return value.length >= 20 && value.length <= 100 && !/\s/.test(value);
}
function isBoolean(value) {
  return value === "true" || value === "false";
}
function isVersion(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
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
function isResendSender(value) {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/^[^<>\r\n]{1,100}<([^<>]+)>$/);
  const email = (bracketed?.[1] ?? trimmed).trim().toLowerCase();
  if (!isEmail(email)) return false;
  if (!email.endsWith("@resend.dev")) return true;
  return (
    email === "onboarding@resend.dev" &&
    env.OWNER_EMAIL?.toLowerCase() === env.NOTIFICATION_EMAIL?.toLowerCase()
  );
}
