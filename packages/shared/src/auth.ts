export interface AuthenticatedUser {
  id: string;
  email?: string;
  expiresAt?: number;
}

export type AuthorizationResult =
  | { authorized: true; user: AuthenticatedUser }
  | { authorized: false; status: 401 | 403; reason: string };

export function authorizeOwner(
  user: AuthenticatedUser | null,
  ownerEmail: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): AuthorizationResult {
  if (!user)
    return {
      authorized: false,
      status: 401,
      reason: "Authentication required",
    };
  if (user.expiresAt && user.expiresAt <= nowSeconds) {
    return { authorized: false, status: 401, reason: "Session expired" };
  }
  if (
    !user.email ||
    user.email.toLowerCase() !== ownerEmail.trim().toLowerCase()
  ) {
    return {
      authorized: false,
      status: 403,
      reason: "This installation has one owner",
    };
  }
  return { authorized: true, user };
}

export function isTokenExpired(
  expiresAt: string | undefined,
  skewSeconds = 60,
): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + skewSeconds * 1_000;
}
