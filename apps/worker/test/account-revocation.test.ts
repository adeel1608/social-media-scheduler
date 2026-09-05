import { describe, expect, it, vi } from "vitest";

import {
  confirmDurableAccountDisconnect,
  disconnectAccountDurably,
  revokeAccountsForInstallationDeletion,
  type DisconnectTransaction,
} from "../src/account-revocation";
import type { SupabaseRest } from "../src/database";
import type { Env } from "../src/env";

const accountId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";

const account = {
  platform: "tiktok" as const,
  encrypted_access_token: "encrypted",
  access_token_nonce: "nonce",
  encryption_key_version: "v1",
};

function transaction(
  state: DisconnectTransaction["state"],
  overrides: Partial<DisconnectTransaction> = {},
): DisconnectTransaction {
  return {
    account_id: accountId,
    operation_id: operationId,
    state,
    expires_at: "2026-09-05T01:12:03.000Z",
    provider_outcome:
      state === "provider_revoked" || state === "completed"
        ? "confirmed"
        : state === "revocation_uncertain"
          ? "uncertain"
          : null,
    ...overrides,
  };
}

function dependencies() {
  return {
    decrypt: vi.fn(async () => "access-token"),
    disconnect: vi.fn(async () => undefined),
    begin: vi.fn(async () => transaction("prepared")),
    markRevocationStarted: vi.fn(async () =>
      transaction("revocation_started", { should_revoke: true }),
    ),
    recordRevocation: vi.fn(async () => transaction("provider_revoked")),
    complete: vi.fn(async () =>
      transaction("completed", { completed_now: true }),
    ),
  };
}

describe("durable account disconnect", () => {
  it("survives response loss and does not repeat provider revocation", async () => {
    const deps = dependencies();

    const first = await disconnectAccountDurably(
      {} as Env,
      {} as SupabaseRest,
      accountId,
      ownerId,
      account,
      deps,
    );
    expect(first).toMatchObject({ completed: true, completedNow: true });

    deps.begin.mockResolvedValueOnce(
      transaction("completed", { completed_now: false }),
    );
    const repeated = await disconnectAccountDurably(
      {} as Env,
      {} as SupabaseRest,
      accountId,
      ownerId,
      account,
      deps,
    );
    expect(repeated).toMatchObject({ completed: true, completedNow: false });
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.markRevocationStarted).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledWith(
      accountId,
      ownerId,
      operationId,
      true,
    );
  });

  it("recovers after database failure following provider revocation", async () => {
    const deps = dependencies();
    deps.recordRevocation.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    deps.complete.mockRejectedValueOnce(new Error("database unavailable"));

    const first = await disconnectAccountDurably(
      {} as Env,
      {} as SupabaseRest,
      accountId,
      ownerId,
      account,
      deps,
    );
    expect(first).toMatchObject({
      completed: false,
      revocationUncertain: true,
      transaction: { state: "revocation_started" },
    });

    deps.begin.mockResolvedValueOnce(transaction("revocation_started"));
    const resumed = await disconnectAccountDurably(
      {} as Env,
      {} as SupabaseRest,
      accountId,
      ownerId,
      account,
      deps,
    );
    expect(resumed).toMatchObject({
      completed: false,
      revocationUncertain: true,
    });
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not repeat revocation after an uncertain provider response", async () => {
    const deps = dependencies();
    deps.disconnect.mockRejectedValueOnce(new Error("network timeout"));
    deps.recordRevocation.mockResolvedValueOnce(
      transaction("revocation_uncertain"),
    );

    const first = await disconnectAccountDurably(
      {} as Env,
      {} as SupabaseRest,
      accountId,
      ownerId,
      account,
      deps,
    );
    expect(first).toMatchObject({
      completed: false,
      revocationUncertain: true,
      transaction: { state: "revocation_uncertain" },
    });

    deps.begin.mockResolvedValueOnce(transaction("revocation_uncertain"));
    await disconnectAccountDurably(
      {} as Env,
      {} as SupabaseRest,
      accountId,
      ownerId,
      account,
      deps,
    );
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.recordRevocation).toHaveBeenCalledWith(
      accountId,
      ownerId,
      operationId,
      "revocation_uncertain",
    );
  });

  it("does not call the provider when the durable marker fails", async () => {
    const deps = dependencies();
    deps.markRevocationStarted.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      disconnectAccountDurably(
        {} as Env,
        {} as SupabaseRest,
        accountId,
        ownerId,
        account,
        deps,
      ),
    ).rejects.toThrow("database unavailable");
    expect(deps.disconnect).not.toHaveBeenCalled();
  });

  it("lets an authenticated recovery call be replay-safe", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce(transaction("completed", { completed_now: true }))
      .mockResolvedValueOnce(
        transaction("completed", { completed_now: false }),
      );
    const db = { rpc } as unknown as SupabaseRest;

    await expect(
      confirmDurableAccountDisconnect(db, accountId, ownerId, operationId),
    ).resolves.toMatchObject({ completed_now: true });
    await expect(
      confirmDurableAccountDisconnect(db, accountId, ownerId, operationId),
    ).resolves.toMatchObject({ completed_now: false });
    expect(rpc).toHaveBeenNthCalledWith(1, "complete_account_disconnect", {
      p_account_id: accountId,
      p_owner_id: ownerId,
      p_operation_id: operationId,
      p_provider_confirmed: false,
    });
  });
});

describe("installation deletion provider revocation", () => {
  it("continues local deletion preparation and reports incomplete revocations", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const disconnect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const incomplete = await revokeAccountsForInstallationDeletion(
      {} as Env,
      [
        {
          platform: "instagram",
          encrypted_access_token: "first",
          access_token_nonce: "nonce",
          encryption_key_version: "v1",
        },
        {
          platform: "tiktok",
          encrypted_access_token: "second",
          access_token_nonce: "nonce",
          encryption_key_version: "v1",
        },
      ],
      {
        decrypt: async (item) => `${item.platform}-test-token`,
        disconnect,
      },
    );

    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(incomplete).toEqual(["tiktok"]);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain("first");
    expect(output).not.toContain("second");
    expect(output).not.toContain("test-token");
  });
});
