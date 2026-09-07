export interface OAuthBindingRecord {
  state_hash: string;
  owner_id: string;
  authorization_context: "owner" | "meta_review";
  authorization_generation: string | null;
  auth_session_id: string;
  initiating_email: string;
  redirect_uri: string;
  expires_at: string;
}

export const oauthCookieName = (platform: string) =>
  `__Host-postline-oauth-${platform}`;

export async function oauthHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function hashOAuthBrowserBinding(
  value: string,
  record: OAuthBindingRecord,
): Promise<string> {
  return oauthHash(
    JSON.stringify([
      "postline-oauth-v1",
      value,
      record.state_hash,
      record.owner_id,
      record.authorization_context,
      record.authorization_generation,
      record.auth_session_id,
      record.initiating_email,
      record.redirect_uri,
      new Date(record.expires_at).toISOString(),
    ]),
  );
}

/** Caller MUST first authenticate this exact bearer token with Supabase Auth. */
export function verifiedOAuthSession(
  jwt: string,
): { id: string; expiresAt: number } | null {
  try {
    const part = jwt.split(".")[1]!;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    ) as Record<string, unknown>;
    if (
      typeof claims.session_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        claims.session_id,
      ) ||
      typeof claims.exp !== "number" ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp * 1000 <= Date.now()
    )
      return null;
    return { id: claims.session_id, expiresAt: claims.exp * 1000 };
  } catch {
    return null;
  }
}
