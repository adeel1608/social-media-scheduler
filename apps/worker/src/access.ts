import { authorizeOwner, type AuthenticatedUser } from "@scheduler/shared";
import type { Context, Next } from "hono";

import type { Env } from "./env";
import { metaReviewerConfiguration } from "./env";

export type AccessRole = "owner" | "meta_reviewer";

export type Variables = {
  user: AuthenticatedUser;
  jwt: string;
  accessRole: AccessRole;
};

export type WorkspaceAuthentication =
  | {
      authenticated: true;
      user: AuthenticatedUser;
      jwt: string;
      accessRole: AccessRole;
    }
  | { authenticated: false; error: string; status: 401 | 403 };

export type OwnerAuthentication =
  | {
      authenticated: true;
      user: AuthenticatedUser;
      jwt: string;
      accessRole: "owner";
    }
  | { authenticated: false; error: string; status: 401 | 403 };

async function authenticatedUser(
  env: Env,
  request: Request,
  fetcher: typeof fetch,
): Promise<
  | { authenticated: true; user: AuthenticatedUser; jwt: string }
  | { authenticated: false; error: string; status: 401 }
> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return {
      authenticated: false,
      error: "authentication_required",
      status: 401,
    };
  }
  const jwt = authorization.slice("Bearer ".length);
  const response = await fetcher(
    `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: authorization,
      },
    },
  );
  if (!response.ok) {
    return {
      authenticated: false,
      error: "invalid_or_expired_session",
      status: 401,
    };
  }
  const payload = (await response.json()) as {
    id?: unknown;
    email?: unknown;
    exp?: unknown;
  };
  if (typeof payload.id !== "string") {
    return {
      authenticated: false,
      error: "invalid_or_expired_session",
      status: 401,
    };
  }
  const user: AuthenticatedUser = {
    id: payload.id,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
  };
  if (user.expiresAt && user.expiresAt <= Math.floor(Date.now() / 1_000)) {
    return {
      authenticated: false,
      error: "invalid_or_expired_session",
      status: 401,
    };
  }
  return { authenticated: true, user, jwt };
}

function jwtHasAuthenticationMethod(jwt: string, expected: string): boolean {
  try {
    if (jwt.length > 16_384) return false;
    const encodedPayload = jwt.split(".")[1];
    if (!encodedPayload) return false;
    const base64 = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      amr?: unknown;
    };
    return (
      Array.isArray(payload.amr) &&
      payload.amr.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { method?: unknown }).method === expected,
      )
    );
  } catch {
    return false;
  }
}

export async function authenticateWorkspaceRequest(
  env: Env,
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<WorkspaceAuthentication> {
  const authentication = await authenticatedUser(env, request, fetcher);
  if (!authentication.authenticated) return authentication;

  const owner = authorizeOwner(authentication.user, env.OWNER_EMAIL);
  if (owner.authorized) {
    return { ...authentication, accessRole: "owner" };
  }

  const reviewer = metaReviewerConfiguration(env);
  if (
    reviewer.enabled &&
    reviewer.configured &&
    authentication.user.id === reviewer.userId &&
    authentication.user.email?.trim().toLowerCase() === reviewer.email &&
    jwtHasAuthenticationMethod(authentication.jwt, "password")
  ) {
    return { ...authentication, accessRole: "meta_reviewer" };
  }

  return { authenticated: false, error: "access_denied", status: 403 };
}

export async function authenticateOwnerRequest(
  env: Env,
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<OwnerAuthentication> {
  const authentication = await authenticateWorkspaceRequest(
    env,
    request,
    fetcher,
  );
  if (!authentication.authenticated) return authentication;
  if (authentication.accessRole !== "owner") {
    return { authenticated: false, error: "access_denied", status: 403 };
  }
  return { ...authentication, accessRole: "owner" };
}

export async function workspaceAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const authentication = await authenticateWorkspaceRequest(c.env, c.req.raw);
  if (!authentication.authenticated) {
    return c.json({ error: authentication.error }, authentication.status);
  }
  c.set("user", authentication.user);
  c.set("jwt", authentication.jwt);
  c.set("accessRole", authentication.accessRole);
  await next();
}

export async function ownerAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const authentication = await authenticateOwnerRequest(c.env, c.req.raw);
  if (!authentication.authenticated) {
    return c.json({ error: authentication.error }, authentication.status);
  }
  c.set("user", authentication.user);
  c.set("jwt", authentication.jwt);
  c.set("accessRole", "owner");
  await next();
}

export function reviewerRouteAllowed(method: string, path: string): boolean {
  const identifier =
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const exact = new Set([
    "GET /api/session",
    "GET /api/storage",
    "GET /api/accounts",
    "GET /api/queue",
    "GET /api/analytics",
    "POST /api/analytics/sync",
    "POST /api/posts",
    "GET /api/capabilities/instagram",
  ]);
  if (exact.has(`${method} ${path}`)) return true;
  return [
    ["GET", new RegExp(`^/api/analytics/${identifier}$`, "i")],
    ["DELETE", new RegExp(`^/api/accounts/${identifier}$`, "i")],
    [
      "POST",
      new RegExp(`^/api/accounts/${identifier}/disconnect/confirm$`, "i"),
    ],
    ["PATCH", new RegExp(`^/api/targets/${identifier}/cancel$`, "i")],
    ["DELETE", new RegExp(`^/api/media/${identifier}$`, "i")],
  ].some(([allowedMethod, pattern]) =>
    allowedMethod === method ? (pattern as RegExp).test(path) : false,
  );
}

export function metaReviewTargetAuthorized(
  env: Env,
  target: {
    authorization_context?: unknown;
    owner_id?: unknown;
    platform?: unknown;
    connected_accounts?: Record<string, unknown> | null;
    posts?: {
      owner_id?: unknown;
      post_media?: Array<{ media_assets?: { owner_id?: unknown } }>;
    };
  },
): boolean {
  const reviewer = metaReviewerConfiguration(env);
  const account = target.connected_accounts;
  return Boolean(
    reviewer.enabled &&
    reviewer.configured &&
    target.authorization_context === "meta_review" &&
    target.owner_id === reviewer.userId &&
    target.platform === "instagram" &&
    account?.owner_id === reviewer.userId &&
    account.platform === "instagram" &&
    account.authorization_context === "meta_review" &&
    account.connection_status === "connected" &&
    target.posts?.owner_id === reviewer.userId &&
    target.posts.post_media?.every(
      (link) => link.media_assets?.owner_id === reviewer.userId,
    ),
  );
}
