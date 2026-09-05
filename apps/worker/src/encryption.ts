import type { EncryptionKeyResolver } from "@scheduler/shared";

import type { Env } from "./env";

// A canonical lowercase identifier keeps the environment-binding convention
// one-to-one, so one stored version can never resolve to an unrelated key.
const KEY_VERSION = /^[a-z][a-z0-9]{0,31}$/;

export function historicalEncryptionKeyBinding(
  keyVersion: string,
): string | null {
  if (!KEY_VERSION.test(keyVersion)) return null;
  return `TOKEN_ENCRYPTION_KEY_${keyVersion.toUpperCase()}`;
}

export function encryptionKeyResolver(env: Env): EncryptionKeyResolver {
  return (keyVersion) => {
    if (keyVersion === env.TOKEN_ENCRYPTION_KEY_VERSION) {
      return env.TOKEN_ENCRYPTION_KEY;
    }
    const binding = historicalEncryptionKeyBinding(keyVersion);
    if (!binding) return undefined;
    const candidate: unknown = Reflect.get(env, binding);
    return typeof candidate === "string" && candidate.length > 0
      ? candidate
      : undefined;
  };
}
