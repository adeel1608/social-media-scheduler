import { authorizeOwner, type AuthenticatedUser } from "@scheduler/shared";
import type { Context, Next } from "hono";

import type { Env } from "./env";

export type Variables = { user: AuthenticatedUser; jwt: string };

export type OwnerAuthentication =
  | { authenticated: true; user: AuthenticatedUser; jwt: string }
  | { authenticated: false; error: string; status: 401 | 403 };

export async function authenticateOwnerRequest(
  env: Env,
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<OwnerAuthentication> {
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
    id: string;
    email?: string;
    exp?: number;
  };
  const user: AuthenticatedUser = {
    id: payload.id,
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.exp ? { expiresAt: payload.exp } : {}),
  };
  const decision = authorizeOwner(user, env.OWNER_EMAIL);
  if (!decision.authorized) {
    return {
      authenticated: false,
      error: decision.reason,
      status: decision.status as 401 | 403,
    };
  }
  return { authenticated: true, user, jwt };
}

export async function ownerAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const authentication = await authenticateOwnerRequest(c.env, c.req.raw);
  if (!authentication.authenticated)
    return c.json({ error: authentication.error }, authentication.status);
  c.set("user", authentication.user);
  c.set("jwt", authentication.jwt);
  await next();
}
