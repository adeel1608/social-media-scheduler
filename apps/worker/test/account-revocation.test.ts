import { describe, expect, it, vi } from "vitest";

import {
  LocalDisconnectPendingError,
  revokeAccountsForInstallationDeletion,
  revokeBeforeLocalDisconnect,
} from "../src/account-revocation";
import type { Env } from "../src/env";

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
        decrypt: async (account) => `${account.platform}-test-token`,
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

  it("marks a normal disconnect locally only after provider revocation succeeds", async () => {
    const order: string[] = [];
    const account = {
      platform: "tiktok" as const,
      encrypted_access_token: "encrypted",
      access_token_nonce: "nonce",
      encryption_key_version: "v1",
    };
    const markLocallyDisconnected = vi.fn(async () => {
      order.push("local");
    });
    const dependencies = {
      decrypt: vi.fn(async () => "access-token"),
      disconnect: vi.fn(async () => {
        order.push("provider");
      }),
    };

    await revokeBeforeLocalDisconnect(
      {} as Env,
      account,
      markLocallyDisconnected,
      dependencies,
    );
    expect(order).toEqual(["provider", "local"]);

    dependencies.disconnect.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    await expect(
      revokeBeforeLocalDisconnect(
        {} as Env,
        account,
        markLocallyDisconnected,
        dependencies,
      ),
    ).rejects.toThrow("provider unavailable");
    expect(markLocallyDisconnected).toHaveBeenCalledTimes(1);
  });

  it("distinguishes local cleanup failure after confirmed provider revocation", async () => {
    const dependencies = {
      decrypt: vi.fn(async () => "access-token"),
      disconnect: vi.fn(async () => undefined),
    };

    await expect(
      revokeBeforeLocalDisconnect(
        {} as Env,
        {
          platform: "youtube",
          encrypted_access_token: "encrypted",
          access_token_nonce: "nonce",
          encryption_key_version: "v1",
        },
        async () => {
          throw new Error("database unavailable");
        },
        dependencies,
      ),
    ).rejects.toBeInstanceOf(LocalDisconnectPendingError);
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
  });
});
