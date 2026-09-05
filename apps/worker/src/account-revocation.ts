import { decryptSecret, type Platform } from "@scheduler/shared";

import { adapterFor } from "./adapters";
import { encryptionKeyResolver } from "./encryption";
import type { Env } from "./env";
import { logWorkerError } from "./logging";

export interface RevocableAccount {
  platform: Platform;
  encrypted_access_token: string;
  access_token_nonce: string;
  encryption_key_version: string;
}

interface RevocationDependencies {
  decrypt(account: RevocableAccount): Promise<string>;
  disconnect(platform: Platform, accessToken: string): Promise<void>;
}

function defaultRevocationDependencies(env: Env): RevocationDependencies {
  return {
    decrypt: (account) =>
      decryptSecret(
        {
          ciphertext: account.encrypted_access_token,
          nonce: account.access_token_nonce,
          algorithm: "AES-GCM",
          keyVersion: account.encryption_key_version,
        },
        encryptionKeyResolver(env),
      ),
    disconnect: (platform, accessToken) =>
      adapterFor(platform, env).disconnect(accessToken),
  };
}

export async function revokeBeforeLocalDisconnect(
  env: Env,
  account: RevocableAccount,
  markLocallyDisconnected: () => Promise<void>,
  dependencies: RevocationDependencies = defaultRevocationDependencies(env),
): Promise<void> {
  const accessToken = await dependencies.decrypt(account);
  await dependencies.disconnect(account.platform, accessToken);
  await markLocallyDisconnected();
}

export async function revokeAccountsForInstallationDeletion(
  env: Env,
  accounts: RevocableAccount[],
  dependencies: RevocationDependencies = defaultRevocationDependencies(env),
): Promise<Platform[]> {
  const incomplete = new Set<Platform>();
  for (const account of accounts) {
    try {
      const accessToken = await dependencies.decrypt(account);
      await dependencies.disconnect(account.platform, accessToken);
    } catch {
      incomplete.add(account.platform);
      logWorkerError("provider_revocation_incomplete", {
        provider: account.platform,
      });
    }
  }
  return [...incomplete];
}
