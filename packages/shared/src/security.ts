const secretKeys =
  /token|secret|authorization|password|cookie|api[-_]?key|signed[-_]?url/i;
const bearer = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const urlSecrets = /([?&](?:token|signature|x-amz-signature|key)=)[^&\s]+/gi;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(bearer, "Bearer [REDACTED]")
      .replace(urlSecrets, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        secretKeys.test(key) ? "[REDACTED]" : redactSecrets(nested),
      ]),
    );
  }
  return value;
}

export function stableIdempotencyKey(
  postId: string,
  targetId: string,
  version = 1,
): string {
  return `post:${postId}:target:${targetId}:v${version}`;
}

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://*.supabase.co https://api.scheduler.invalid; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}
