import type { PublicWebConfiguration } from "./publicIdentity.ts";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function createCloudflarePagesHeaders(
  configuration: PublicWebConfiguration,
): string {
  const connectSources = [
    "'self'",
    configuration.apiUrl,
    configuration.supabaseUrl,
    "https://*.ingest.uploadthing.com",
  ]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" ");

  return `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' ${TURNSTILE_ORIGIN}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src ${connectSources}; frame-src ${TURNSTILE_ORIGIN}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
`;
}
