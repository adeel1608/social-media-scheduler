import {
  encryptSecret,
  decryptSecret,
  createOAuthState,
  createPkceChallenge,
  createPkceVerifier,
  safeStateEquals,
  type Platform,
} from "@scheduler/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie } from "hono/cookie";
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
  oauthCompletionCookieName,
  hashOAuthBrowserBinding,
  readSingleCookie,
  verifiedOAuthSession,
  type OAuthBindingRecord,
  type OAuthCompletionRecord,
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

type OAuthContext = Context<{ Bindings: Env; Variables: Variables }>;

const browserSecretPattern = /^[A-Za-z0-9_-]{32,128}$/;

function clearOAuthCookies(c: OAuthContext, platform: Platform): void {
  for (const name of [
    oauthCookieName(platform),
    oauthCompletionCookieName(platform),
  ]) {
    setCookie(c, name, "", {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "None",
      maxAge: 0,
    });
  }
}

function oauthAuthorizationArgs(env: Env, platform: Platform) {
  const reviewer = metaReviewerConfiguration(env);
  return {
    p_owner_email: env.OWNER_EMAIL.trim().toLowerCase(),
    p_review_enabled: env.META_REVIEW_MODE === "true" && reviewer.configured,
    p_reviewer_id: reviewer.configured ? reviewer.userId : null,
    p_reviewer_email: reviewer.configured ? reviewer.email : null,
    p_redirect_uri: redirectUriFor(platform, env),
  };
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

oauth.post("/cancel", async (c) => {
  const authentication = await authenticateWorkspaceRequest(c.env, c.req.raw);
  if (!authentication.authenticated)
    return c.json({ error: authentication.error }, authentication.status);
  const session = verifiedOAuthSession(authentication.jwt);
  if (!session) return c.json({ error: "invalid_oauth_session" }, 401);
  await new SupabaseRest(c.env).rpc("cancel_pending_oauth", {
    p_owner_id: authentication.user.id,
    p_auth_session_id: session.id,
  });
  for (const platform of ["instagram", "tiktok", "youtube"] as const)
    clearOAuthCookies(c, platform);
  return c.json({ ok: true });
});

oauth.get("/:platform/callback", async (c) => {
  const platform = c.req.param("platform") ?? "";
  if (!isPlatform(platform))
    return c.json({ error: "unsupported_platform" }, 404);

  const query = new URL(c.req.url).searchParams;
  const codes = query.getAll("code");
  const states = query.getAll("state");
  if (
    codes.length !== 1 ||
    states.length !== 1 ||
    !codes[0] ||
    !states[0] ||
    codes[0].length > 4096 ||
    states[0].length > 128
  )
    return c.json({ error: "missing_oauth_parameters" }, 400);
  const code = codes[0];
  const state = states[0];
  const browserBinding = readSingleCookie(c.req.raw, oauthCookieName(platform));
  if (!browserBinding || !browserSecretPattern.test(browserBinding))
    return c.json({ error: "invalid_oauth_browser_binding" }, 403);

  const db = new SupabaseRest(c.env);
  const records = await db.select<
    Array<OAuthBindingRecord & Record<string, unknown>>
  >(
    `oauth_states?state_hash=eq.${await oauthHash(state)}&platform=eq.${platform}&consumed_at=is.null&select=*&limit=1`,
  );
  const record = records[0];
  if (!record || new Date(record.expires_at).getTime() <= Date.now())
    return c.json({ error: "invalid_or_expired_oauth_state" }, 400);
  if (
    record.redirect_uri !== redirectUriFor(platform, c.env) ||
    !oauthStateAuthorizationValid(c.env, platform, record)
  ) {
    clearOAuthCookies(c, platform);
    return c.json({ error: "reviewer_oauth_not_authorized" }, 403);
  }
  const bindingHash = await hashOAuthBrowserBinding(browserBinding, record);
  if (
    typeof record.browser_binding_hash !== "string" ||
    !safeStateEquals(bindingHash, record.browser_binding_hash)
  ) {
    clearOAuthCookies(c, platform);
    return c.json({ error: "invalid_oauth_browser_binding" }, 403);
  }
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation ?? undefined,
    );

  const encryptedCode = await encryptSecret(
    code,
    c.env.TOKEN_ENCRYPTION_KEY,
    c.env.TOKEN_ENCRYPTION_KEY_VERSION,
  );
  const completionHandle = createOAuthState();
  const recorded = await db.rpc<Array<OAuthBindingRecord>>(
    "record_bound_oauth_callback",
    {
      p_state_hash: record.state_hash,
      p_browser_binding_hash: bindingHash,
      p_platform: platform,
      p_authorization_code: encryptedCode.ciphertext,
      p_authorization_code_nonce: encryptedCode.nonce,
      p_authorization_code_key_version: encryptedCode.keyVersion,
      p_completion_handle_hash: await oauthHash(completionHandle),
      ...oauthAuthorizationArgs(c.env, platform),
    },
  );
  if (recorded.length !== 1) {
    clearOAuthCookies(c, platform);
    return c.json({ error: "oauth_state_already_consumed" }, 400);
  }

  const maxAge = Math.max(
    1,
    Math.min(
      600,
      Math.floor((new Date(record.expires_at).getTime() - Date.now()) / 1000),
    ),
  );
  // The callback is a top-level Lax navigation. Completion is an authenticated
  // cross-site form POST from Pages to workers.dev, so both narrowly scoped
  // HttpOnly cookies must use Secure + SameSite=None for that one transition.
  setCookie(c, oauthCookieName(platform), browserBinding, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    maxAge,
  });
  setCookie(c, oauthCompletionCookieName(platform), completionHandle, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None",
    maxAge,
  });
  return c.redirect(
    `${c.env.APP_URL}/accounts?oauth=pending&platform=${platform}`,
    303,
  );
});

oauth.post("/:platform/complete", bodyLimit({ maxSize: 20_000 }), async (c) => {
  const platform = c.req.param("platform") ?? "";
  if (!isPlatform(platform))
    return c.json({ error: "unsupported_platform" }, 404);
  const form =
    c.req
      .header("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded") === true;
  let request = c.req.raw;
  if (form) {
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
  const currentSession = verifiedOAuthSession(authentication.jwt);
  const currentEmail = authentication.user.email?.trim().toLowerCase();
  if (!currentSession || !currentEmail)
    return c.json({ error: "invalid_oauth_session" }, 401);

  const browserBinding = readSingleCookie(c.req.raw, oauthCookieName(platform));
  const completionHandle = readSingleCookie(
    c.req.raw,
    oauthCompletionCookieName(platform),
  );
  if (
    !browserBinding ||
    !completionHandle ||
    !browserSecretPattern.test(browserBinding) ||
    !browserSecretPattern.test(completionHandle)
  )
    return c.json({ error: "invalid_oauth_completion_cookie" }, 403);

  const completionHandleHash = await oauthHash(completionHandle);
  const db = new SupabaseRest(c.env);
  const candidates = await db.select<
    Array<OAuthBindingRecord & Record<string, unknown>>
  >(
    `oauth_states?pending_completion_handle_hash=eq.${completionHandleHash}&platform=eq.${platform}&completion_consumed_at=is.null&select=*&limit=1`,
  );
  const candidate = candidates[0];
  if (!candidate)
    return c.json({ error: "invalid_or_consumed_oauth_completion" }, 400);
  const bindingHash = await hashOAuthBrowserBinding(browserBinding, candidate);
  if (
    typeof candidate.browser_binding_hash !== "string" ||
    !safeStateEquals(bindingHash, candidate.browser_binding_hash)
  ) {
    clearOAuthCookies(c, platform);
    return c.json({ error: "invalid_oauth_browser_binding" }, 403);
  }

  const consumed = await db.rpc<OAuthCompletionRecord[]>(
    "consume_oauth_completion",
    {
      p_completion_handle_hash: completionHandleHash,
      p_browser_binding_hash: bindingHash,
      p_platform: platform,
      p_current_owner_id: authentication.user.id,
      p_current_email: currentEmail,
      p_current_auth_session_id: currentSession.id,
      ...oauthAuthorizationArgs(c.env, platform),
    },
  );
  if (consumed.length !== 1) {
    clearOAuthCookies(c, platform);
    return c.json({ error: "oauth_completion_not_authorized" }, 403);
  }
  const record = consumed[0]!;
  clearOAuthCookies(c, platform);
  if (
    record.owner_id !== authentication.user.id ||
    record.initiating_email !== currentEmail ||
    record.auth_session_id !== currentSession.id ||
    record.redirect_uri !== redirectUriFor(platform, c.env) ||
    !oauthStateAuthorizationValid(c.env, platform, record)
  )
    return c.json({ error: "oauth_completion_not_authorized" }, 403);
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation ?? undefined,
    );

  const [code, verifier] = await Promise.all([
    decryptSecret(
      {
        ciphertext: record.pending_authorization_code,
        nonce: record.pending_authorization_code_nonce,
        algorithm: "AES-GCM",
        keyVersion: record.pending_authorization_code_key_version,
      },
      encryptionKeyResolver(c.env),
    ),
    decryptSecret(
      {
        ciphertext: record.encrypted_pkce_verifier,
        nonce: record.pkce_nonce,
        algorithm: "AES-GCM",
        keyVersion: record.encryption_key_version,
      },
      encryptionKeyResolver(c.env),
    ),
  ]);
  const adapter = adapterFor(platform, c.env);
  if (record.authorization_context === "meta_review")
    await requireReviewerAuthorization(
      c.env,
      record.owner_id,
      record.authorization_generation ?? undefined,
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
      record.authorization_generation ?? undefined,
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
      record.authorization_generation ?? undefined,
    );
  await db.rpc("persist_bound_oauth_account", {
    p_state_id: record.id,
    p_browser_binding_hash: bindingHash,
    ...oauthAuthorizationArgs(c.env, platform),
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
  return c.redirect(`${c.env.APP_URL}/accounts?connected=${platform}`, 303);
});

export default oauth;
