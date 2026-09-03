import { uploadThingAppId } from "./storage";

export interface Env {
  PUBLISH_QUEUE: Queue<QueueJob>;
  ENVIRONMENT: string;
  APP_URL: string;
  WORKER_PUBLIC_URL: string;
  OWNER_EMAIL: string;
  NOTIFICATION_EMAIL: string;
  TIMEZONE: string;
  LIVE_TEST_CONFIRM: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  TOKEN_ENCRYPTION_KEY_VERSION: string;
  UPLOADTHING_TOKEN: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  META_APP_ID: string;
  META_APP_SECRET: string;
  META_REDIRECT_URI: string;
  META_GRAPH_VERSION: string;
  META_APP_REVIEW_APPROVED: string;
  TIKTOK_CLIENT_KEY: string;
  TIKTOK_CLIENT_SECRET: string;
  TIKTOK_REDIRECT_URI: string;
  TIKTOK_CONTENT_POSTING_AUDITED: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  YOUTUBE_API_AUDIT_APPROVED: string;
}

export interface QueueJob {
  targetId: string;
  mode: "publish" | "upload" | "poll";
  requestedAt: string;
}

export const requiredProductionEnv: Array<keyof Env> = [
  "PUBLISH_QUEUE",
  "APP_URL",
  "WORKER_PUBLIC_URL",
  "OWNER_EMAIL",
  "NOTIFICATION_EMAIL",
  "TIMEZONE",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "UPLOADTHING_TOKEN",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_REDIRECT_URI",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_REDIRECT_URI",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
];

function isBasicEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }

  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;

  const domain = value.slice(at + 1);
  const lastDot = domain.lastIndexOf(".");
  return lastDot > 0 && lastDot < domain.length - 1;
}

export function configurationStatus(env: Env) {
  const missing = requiredProductionEnv.filter((key) => !env[key]);
  const invalid: Array<keyof Env> = [];
  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      if (atob(env.TOKEN_ENCRYPTION_KEY).length !== 32)
        invalid.push("TOKEN_ENCRYPTION_KEY");
    } catch {
      invalid.push("TOKEN_ENCRYPTION_KEY");
    }
  }
  if (env.UPLOADTHING_TOKEN) {
    try {
      uploadThingAppId(env.UPLOADTHING_TOKEN);
    } catch {
      invalid.push("UPLOADTHING_TOKEN");
    }
  }
  for (const key of [
    "APP_URL",
    "WORKER_PUBLIC_URL",
    "SUPABASE_URL",
    "META_REDIRECT_URI",
    "TIKTOK_REDIRECT_URI",
    "GOOGLE_REDIRECT_URI",
  ] as const) {
    const value = env[key];
    if (!value) continue;
    try {
      const url = new URL(value);
      const localHttp =
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1");
      if (url.protocol !== "https:" && !localHttp) invalid.push(key);
      if (
        key === "WORKER_PUBLIC_URL" &&
        (url.pathname !== "/" ||
          url.search ||
          url.hash ||
          url.username ||
          url.password ||
          url.port)
      )
        invalid.push(key);
    } catch {
      invalid.push(key);
    }
  }
  for (const key of ["OWNER_EMAIL", "NOTIFICATION_EMAIL"] as const) {
    if (env[key] && !isBasicEmail(env[key])) invalid.push(key);
  }
  if (env.TIMEZONE) {
    try {
      new Intl.DateTimeFormat("en-AU", { timeZone: env.TIMEZONE });
    } catch {
      invalid.push("TIMEZONE");
    }
  }
  const approvals = {
    instagram: env.META_APP_REVIEW_APPROVED === "true",
    tiktok: env.TIKTOK_CONTENT_POSTING_AUDITED === "true",
    youtube: env.YOUTUBE_API_AUDIT_APPROVED === "true",
  };
  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid: [...new Set(invalid)],
    approvals,
    liveTestSafetyEnabled: env.LIVE_TEST_CONFIRM === "true",
    environment: env.ENVIRONMENT,
  };
}

export function assertProductionConfigured(env: Env): void {
  const status = configurationStatus(env);
  if (env.ENVIRONMENT === "production" && !status.configured) {
    throw new Error(
      `Production configuration incomplete: missing [${status.missing.join(", ")}], invalid [${status.invalid.join(", ")}]`,
    );
  }
}
