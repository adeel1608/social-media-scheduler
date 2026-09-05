import {
  encryptSecret,
  decryptSecret,
  createOAuthState,
  createPkceChallenge,
  createPkceVerifier,
  type Platform,
} from "@scheduler/shared";
import { Hono } from "hono";

import { adapterFor, redirectUriFor } from "./adapters";
import type { Variables } from "./auth";
import { ownerAuth } from "./auth";
import { ownerDatabase, SupabaseRest } from "./database";
import { encryptionKeyResolver } from "./encryption";
import type { Env } from "./env";

const oauth = new Hono<{ Bindings: Env; Variables: Variables }>();

function isPlatform(value: string): value is Platform {
  return value === "instagram" || value === "tiktok" || value === "youtube";
}

async function hashState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

oauth.post("/:platform/start", ownerAuth, async (c) => {
  const platform = c.req.param("platform") ?? "";
  if (!isPlatform(platform))
    return c.json({ error: "unsupported_platform" }, 404);
  const allowed = await ownerDatabase(c.env, c.get("jwt")).rpc<boolean>(
    "consume_rate_limit",
    { p_route: "oauth_start", p_limit: 10, p_window_seconds: 60 },
  );
  if (!allowed) return c.json({ error: "rate_limit_exceeded" }, 429);
  const state = createOAuthState();
  const verifier = createPkceVerifier();
  const challenge = await createPkceChallenge(verifier);
  const encrypted = await encryptSecret(
    verifier,
    c.env.TOKEN_ENCRYPTION_KEY,
    c.env.TOKEN_ENCRYPTION_KEY_VERSION,
  );
  const db = new SupabaseRest(c.env);
  await db.insert("oauth_states", {
    owner_id: c.get("user").id,
    platform,
    state_hash: await hashState(state),
    encrypted_pkce_verifier: encrypted.ciphertext,
    pkce_nonce: encrypted.nonce,
    encryption_key_version: encrypted.keyVersion,
    redirect_uri: redirectUriFor(platform, c.env),
    expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  });
  const authorizationUrl = adapterFor(platform, c.env).getAuthorizationUrl({
    redirectUri: redirectUriFor(platform, c.env),
    state,
    codeChallenge: challenge,
  });
  return c.json({ authorizationUrl });
});

oauth.get("/:platform/callback", async (c) => {
  const platform = c.req.param("platform") ?? "";
  if (!isPlatform(platform))
    return c.json({ error: "unsupported_platform" }, 404);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state)
    return c.json({ error: "missing_oauth_parameters" }, 400);
  const db = new SupabaseRest(c.env);
  const records = await db.select<Array<Record<string, any>>>(
    `oauth_states?state_hash=eq.${await hashState(state)}&platform=eq.${platform}&consumed_at=is.null&select=*&limit=1`,
  );
  const record = records[0];
  if (!record || new Date(record.expires_at) <= new Date())
    return c.json({ error: "invalid_or_expired_oauth_state" }, 400);
  const consumed = await db.update<Array<Record<string, any>>>(
    `oauth_states?id=eq.${record.id}&consumed_at=is.null`,
    { consumed_at: new Date().toISOString() },
  );
  if (consumed.length !== 1)
    return c.json({ error: "oauth_state_already_consumed" }, 400);
  const verifier = await decryptSecret(
    {
      ciphertext: record.encrypted_pkce_verifier,
      nonce: record.pkce_nonce,
      algorithm: "AES-GCM",
      keyVersion: record.encryption_key_version,
    },
    encryptionKeyResolver(c.env),
  );
  const adapter = adapterFor(platform, c.env);
  const tokens = await adapter.exchangeAuthorizationCode(
    code,
    record.redirect_uri,
    verifier,
  );
  const profile = await adapter.getAccountProfile(tokens.accessToken);
  const access = await encryptSecret(
    tokens.accessToken,
    c.env.TOKEN_ENCRYPTION_KEY,
    c.env.TOKEN_ENCRYPTION_KEY_VERSION,
  );
  const refresh = tokens.refreshToken
    ? await encryptSecret(
        tokens.refreshToken,
        c.env.TOKEN_ENCRYPTION_KEY,
        c.env.TOKEN_ENCRYPTION_KEY_VERSION,
      )
    : null;
  await db.insert(
    "connected_accounts?on_conflict=owner_id,platform,remote_account_id",
    {
      owner_id: record.owner_id,
      platform,
      remote_account_id: profile.id,
      username: profile.username,
      encrypted_access_token: access.ciphertext,
      access_token_nonce: access.nonce,
      encrypted_refresh_token: refresh?.ciphertext,
      refresh_token_nonce: refresh?.nonce,
      encryption_key_version: access.keyVersion,
      scopes: tokens.scopes,
      token_expires_at: tokens.expiresAt,
      connection_status: "connected",
      approval_state: adapter.getCapabilities().supportsDirectPublicPublishing
        ? "approved"
        : "pending",
      metadata: {
        displayName: profile.displayName,
        accountType: profile.accountType,
        ...(typeof tokens.raw.refreshTokenExpiresAt === "string"
          ? { refreshTokenExpiresAt: tokens.raw.refreshTokenExpiresAt }
          : {}),
      },
    },
    "resolution=merge-duplicates,return=representation",
  );
  return c.redirect(`${c.env.APP_URL}/accounts?connected=${platform}`);
});

export default oauth;
