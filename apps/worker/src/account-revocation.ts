import { decryptSecret, type Platform } from "@scheduler/shared";

import { adapterFor } from "./adapters";
import type { SupabaseRest } from "./database";
import { encryptionKeyResolver } from "./encryption";
import type { Env } from "./env";
import { logWorkerError } from "./logging";

export interface RevocableAccount {
  platform: Platform;
  encrypted_access_token: string;
  access_token_nonce: string;
  encryption_key_version: string;
}

export type DisconnectTransactionState =
  | "prepared"
  | "revocation_started"
  | "provider_revoked"
  | "revocation_uncertain"
  | "completed";

export interface DisconnectTransaction {
  account_id: string;
  operation_id: string;
  state: DisconnectTransactionState;
  expires_at: string;
  provider_outcome?: "confirmed" | "uncertain" | null;
  should_revoke?: boolean;
  completed_now?: boolean;
}

export interface DurableDisconnectResult {
  completed: boolean;
  completedNow: boolean;
  providerRevoked: boolean;
  revocationUncertain: boolean;
  transaction: DisconnectTransaction;
}

interface ProviderRevocationDependencies {
  decrypt(account: RevocableAccount): Promise<string>;
  disconnect(platform: Platform, accessToken: string): Promise<void>;
}

interface RevocationDependencies extends ProviderRevocationDependencies {
  begin(accountId: string, ownerId: string): Promise<DisconnectTransaction>;
  markRevocationStarted(
    accountId: string,
    ownerId: string,
    operationId: string,
  ): Promise<DisconnectTransaction>;
  recordRevocation(
    accountId: string,
    ownerId: string,
    operationId: string,
    outcome: "provider_revoked" | "revocation_uncertain",
  ): Promise<DisconnectTransaction>;
  complete(
    accountId: string,
    ownerId: string,
    operationId: string,
    providerConfirmed: boolean,
  ): Promise<DisconnectTransaction>;
}

function defaultProviderRevocationDependencies(
  env: Env,
): ProviderRevocationDependencies {
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

function defaultRevocationDependencies(
  env: Env,
  db: SupabaseRest,
): RevocationDependencies {
  return {
    ...defaultProviderRevocationDependencies(env),
    begin: (accountId, ownerId) =>
      db.rpc<DisconnectTransaction>("begin_account_disconnect", {
        p_account_id: accountId,
        p_owner_id: ownerId,
      }),
    markRevocationStarted: (accountId, ownerId, operationId) =>
      db.rpc<DisconnectTransaction>(
        "mark_account_disconnect_revocation_started",
        {
          p_account_id: accountId,
          p_owner_id: ownerId,
          p_operation_id: operationId,
        },
      ),
    recordRevocation: (accountId, ownerId, operationId, outcome) =>
      db.rpc<DisconnectTransaction>("record_account_disconnect_revocation", {
        p_account_id: accountId,
        p_owner_id: ownerId,
        p_operation_id: operationId,
        p_outcome: outcome,
      }),
    complete: (accountId, ownerId, operationId, providerConfirmed) =>
      db.rpc<DisconnectTransaction>("complete_account_disconnect", {
        p_account_id: accountId,
        p_owner_id: ownerId,
        p_operation_id: operationId,
        p_provider_confirmed: providerConfirmed,
      }),
  };
}

function resultForTransaction(
  transaction: DisconnectTransaction,
  completedNow = false,
): DurableDisconnectResult {
  return {
    completed: transaction.state === "completed",
    completedNow,
    providerRevoked:
      transaction.state === "provider_revoked" ||
      (transaction.state === "completed" &&
        transaction.provider_outcome === "confirmed"),
    revocationUncertain:
      transaction.state === "revocation_started" ||
      transaction.state === "revocation_uncertain" ||
      (transaction.state === "completed" &&
        transaction.provider_outcome === "uncertain"),
    transaction,
  };
}

export async function disconnectAccountDurably(
  env: Env,
  db: SupabaseRest,
  accountId: string,
  ownerId: string,
  account: RevocableAccount,
  dependencies: RevocationDependencies = defaultRevocationDependencies(env, db),
): Promise<DurableDisconnectResult> {
  let transaction = await dependencies.begin(accountId, ownerId);
  if (transaction.state === "completed")
    return resultForTransaction(transaction, false);
  if (transaction.state !== "prepared")
    return resultForTransaction(transaction, false);

  // Decrypt before the write-ahead boundary. If this fails, a later request can
  // safely retry without any provider request having been attempted.
  const accessToken = await dependencies.decrypt(account);
  transaction = await dependencies.markRevocationStarted(
    accountId,
    ownerId,
    transaction.operation_id,
  );
  if (!transaction.should_revoke)
    return resultForTransaction(transaction, false);

  // markRevocationStarted is intentionally the final await before revocation.
  try {
    await dependencies.disconnect(account.platform, accessToken);
  } catch {
    try {
      transaction = await dependencies.recordRevocation(
        accountId,
        ownerId,
        transaction.operation_id,
        "revocation_uncertain",
      );
    } catch {
      // The durable write-ahead state still prevents a second revocation call.
    }
    return resultForTransaction(transaction, false);
  }

  try {
    transaction = await dependencies.recordRevocation(
      accountId,
      ownerId,
      transaction.operation_id,
      "provider_revoked",
    );
  } catch {
    // Completion accepts revocation_started so a transient result-write failure
    // need not strand cleanup after a confirmed provider response.
  }
  try {
    transaction = await dependencies.complete(
      accountId,
      ownerId,
      transaction.operation_id,
      true,
    );
    return resultForTransaction(
      transaction,
      transaction.completed_now === true,
    );
  } catch {
    return resultForTransaction(transaction, false);
  }
}

export async function confirmDurableAccountDisconnect(
  db: SupabaseRest,
  accountId: string,
  ownerId: string,
  operationId: string,
): Promise<DisconnectTransaction> {
  return db.rpc<DisconnectTransaction>("complete_account_disconnect", {
    p_account_id: accountId,
    p_owner_id: ownerId,
    p_operation_id: operationId,
    p_provider_confirmed: false,
  });
}

export async function revokeAccountsForInstallationDeletion(
  env: Env,
  accounts: RevocableAccount[],
  dependencies: ProviderRevocationDependencies = defaultProviderRevocationDependencies(
    env,
  ),
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
