import {
  encryptSecret,
  decryptSecret,
  createOAuthState,
  createPkceChallenge,
  createPkceVerifier,
  safeStateEquals,
  type Platform,
} from "@scheduler/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";

import { adapterFor, redirectUriFor } from "./adapters";
import type { Variables } from "./auth";
import { authenticateWorkspaceRequest } from "./auth";
import { ownerDatabase, SupabaseRest } from "./database";
import { encryptionKeyResolver } from "./encryption";
import type { Env } from "./env";
import { metaReviewerConfiguration } from "./env";
import {
  requireReviewerAuthorization,
  ReviewerDatabase,
} from "./review-authorization";
import {
  oauthHash,
  oauthCookieName,
  hashOAuthBrowserBinding,
  verifiedOAuthSession,
  type OAuthBindingRecord,
} from "./oauth-binding";

const oauth = new Hono<{ Bindings: Env; Variables: Variables }>();

oauth.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

function isPlatform(value: string): value is Platform {
  return value === "instagram" || value === "tiktok" || value === "youtube";
}

export function oauthStateAuthorizationValid(
  env: Env,
  platform: Platform,
  record: { owner_id?: unknown; authorization_context?: unknown },
): boolean {
  if (record.authorization_context === "owner") return true;
  if (record.authorization_context !== "meta_review") return false;
  const reviewer = metaReviewerConfiguration(env);
  return Boolean(
    reviewer.enabled &&
    reviewer.configured &&
    platform === "instagram" &&
    record.owner_id === reviewer.userId,
  );
}

oauth.post("/:platform/start", bodyLimit({ maxSize: 20_000 }), async (c) => {
  const platform = c.req.param("platform") ?? "";
  if (!isPlatform(platform))
    return c.json({ error: "unsupported_platform" }, 404);
  const form =
    c.req
      .header("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded") === true;
  let request = c.req.raw;
  if (form) {
    // Top-level navigation lets Lax cookies work without third-party cookies
    // between Pages and workers.dev. Never put the bearer token in a URL.
    if (c.req.header("Origin") !== c.env.APP_URL)
      return c.json({ error: "invalid_oauth_origin" }, 403);
    const body = await c.req.parseBody();
    if (
      typeof body.session_token !== "string" ||
      body.session_token.length > 16_384
    )
      return c.json({ error: "authentication_required" }, 401);
    request = new Request(c.req.url, {
      headers: { Authorization: `Bearer ${body.session_token}` },
    });
  }
  const authentication = await authenticateWorkspaceRequest(c.env, request);
  if (!authentication.authenticated)
    return c.json({ error: authentication.error }, authentication.status);
  c.set("user", authentication.user);
  c.set("jwt", authentication.jwt);
  c.set("accessRole", authentication.accessRole);
  c.set("reviewGeneration", authentication.reviewGeneration);
  const session = verifiedOAuthSession(authentication.jwt);
  if (!session) return c.json({ error: "invalid_oauth_session" }, 401);
  const reviewer = c.get("accessRole") === "meta_reviewer";
  if (reviewer && platform !== "instagram") {
    return c.json({ error: "reviewer_platform_not_allowed" }, 403);
  }
  const allowed = reviewer
    ? await new ReviewerDatabase(
        c.env,
        authentication.user.id,
        authentication.reviewGeneration!,
      ).rpc<boolean>("consume_meta_review_rate_limit", {
        p_reviewer_id: c.get("user").id,
        p_route: "oauth_start",
        p_limit: 10,
        p_window_seconds: 60,
      })
    : await ownerDatabase(c.env, c.get("jwt")).rpc<boolean>(
        "consume_rate_limit",
        { p_route: "oauth_start", p_limit: 10, p_window_seconds: 60 },
      );
  if (!allowed) return c.json({ error: "rate_limit_exceeded" }, 429);
  const state = createOAuthState();
  const binding = createOAuthState();
  const verifier = createPkceVerifier();
  const challenge = await createPkceChallenge(verifier);
  const encrypted = await encryptSecret(
    verifier,
    c.env.TOKEN_ENCRYPTION_KEY,
    c.env.TOKEN_ENCRYPTION_KEY_VERSION,
  );
  const db = new SupabaseRest(c.env);
  const bindingRecord: OAuthBindingRecord = {
    owner_id: authentication.user.id,
    authorization_context: reviewer ? "meta_review" : "owner",
    authorization_generation: authentication.reviewGeneration ?? null,
    state_hash: await oauthHash(state),
    auth_session_id: session.id,
    initiating_email: authentication.user.email!.trim().toLowerCase(),
    redirect_uri: redirectUriFor(platform, c.env),
    expires_at: new Date(
      Math.min(Date.now() + 10 * 60_000, session.expiresAt),
    ).toISOString(),
  };
  if (reviewer)
    await requireReviewerAuthorization(
      c.env,
      authentication.user.id,
      authentication.reviewGeneration,
    );
  await db.insert("oauth_states", {
    ...bindingRecord,
    browser_binding_hash: await hashOAuthBrowserBinding(binding, bindingRecord),
    platform,
    encrypted_pkce_verifier: encrypted.ciphertext,
    pkce_nonce: encrypted.nonce,
    encryption_key_version: encrypted.keyVersion,
  });
  const authorizationUrl = adapterFor(platform, c.env).getAuthorizationUrl({
    redirectUri: redirectUriFor(platform, c.env),
    state,
    codeChallenge: challenge,
  });
  setCookie(c, oauthCookieName(platform), binding, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 600,
  });
  if (form) {
    // HTML navigation, not a form redirect chain: no broad provider form-action
    // CSP allowlist is needed. Hono escapes both attribute interpolations.
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="referrer" content="no-referrer" />
            <meta http-equiv="refresh" content="0;url=${authorizationUrl}" />
            <title>Continue account connection</title>
          </head>
          <body>
            <p><a href="${authorizationUrl}">Continue account connection</a></p>
          </body>
        </html>`,
    );
  }
  return c.json({ authorizationUrl });
});

oauth.get("/:platform/callback", async (c) => {
  const platform = c.req.param("platform") ?? "";
  if (!isPlatform(platform))
    return c.json({ error: "unsupported_platform" }, 404);
  const code = c.req.query("code");
  const state = c.req.query("state");
  const browserBinding = getCookie(c, oauthCookieName(platform));
  setCookie(c, oauthCookieName(platform), "", {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 0,
  });
  if (!code || !state || code.length > 4096 || state.length > 128)
    return c.json({ error: "missing_oauth_parameters" }, 400);
  if (!browserBinding || !/^[A-Za-z0-9_-]{32,128}$/.test(browserBinding))
    return c.json({ error: "invalid_oauth_browser_binding" }, 403);
  const db = new SupabaseRest(c.env);
  const records = await db.select<Array<Record<string, any>>>(
    `oauth_states?state_hash=eq.${await oauthHash(state)}&platform=eq.${platform}&consumed_at=is.null&select=*&limit=1`,
  );
  const record = records[0];
  if (!record || new Date(record.expires_at) <= new Date())
    return c.json({ error: "invalid_or_expired_oauth_state" }, 400);
  if (
    record.redirect_uri !== redirectUriFor(platform, c.env) ||
    !oauthStateAuthorizationValid(c.env, platform, record)
  )
    return c.json({ error: "reviewer_oauth_not_authorized" }, 403);
  const bindingHash = await hashOAuthBrowserBinding(
    browserBinding,
    record as OAuthBindingRecord,
  );
  if (
    typeof record.browser_binding_hash !== "string" ||
    !safeStateEquals(bindingHash, record.browser_binding_hash)
  )
    return c.json({ error: "invalid_oauth_browser_binding" }, 403);
  const reviewerConfig = metaReviewerConfiguration(c.env);
  const authorizationArgs = () => ({
    p_owner_email: c.env.OWNER_EMAIL.trim().toLowerCase(),
    p_review_enabled:
      c.env.META_REVIEW_MODE === "true" && reviewerConfig.configured,
    p_reviewer_id: reviewerConfig.configured ? reviewerConfig.userId : null,
    p_reviewer_email: reviewerConfig.configured ? reviewerConfig.email : null,
    p_redirect_uri: redirectUriFor(platform, c.env),
  });
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation,
    );
  const consumed = await db.rpc<Array<Record<string, any>>>(
    "consume_bound_oauth_state",
    {
      p_state_hash: record.state_hash,
      p_browser_binding_hash: bindingHash,
      p_platform: platform,
      ...authorizationArgs(),
    },
  );
  if (consumed.length !== 1)
    return c.json({ error: "oauth_state_already_consumed" }, 400);
  if (!oauthStateAuthorizationValid(c.env, platform, record)) {
    return c.json(
      {
        error:
          record.authorization_context === "meta_review"
            ? "reviewer_oauth_not_authorized"
            : "invalid_oauth_authorization_context",
      },
      record.authorization_context === "meta_review" ? 403 : 400,
    );
  }
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
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation,
    );
  const tokens = await adapter.exchangeAuthorizationCode(
    code,
    record.redirect_uri,
    verifier,
  );
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation,
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
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation,
    );
  await db.rpc("persist_bound_oauth_account", {
    p_state_id: record.id,
    p_browser_binding_hash: bindingHash,
    ...authorizationArgs(),
    p_account: {
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
  });
  return c.redirect(`${c.env.APP_URL}/accounts?connected=${platform}`);
});

export default oauth;
