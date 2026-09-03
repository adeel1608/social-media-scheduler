import { authorizeOwner, type AuthenticatedUser } from "@scheduler/shared";
import type { Context, Next } from "hono";

import type { Env } from "./env";

export type Variables = { user: AuthenticatedUser; jwt: string };

export async function ownerAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next,
) {
  const authorization = c.req.header("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return c.json({ error: "authentication_required" }, 401);
  }
  const jwt = authorization.slice("Bearer ".length);
  const response = await fetch(
    `${c.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
    {
      headers: {
        apikey: c.env.SUPABASE_ANON_KEY,
        Authorization: authorization,
      },
    },
  );
  if (!response.ok) return c.json({ error: "invalid_or_expired_session" }, 401);
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
  const decision = authorizeOwner(user, c.env.OWNER_EMAIL);
  if (!decision.authorized)
    return c.json({ error: decision.reason }, decision.status);
  c.set("user", user);
  c.set("jwt", jwt);
  await next();
}
