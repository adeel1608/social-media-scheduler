import { describe, expect, it } from "vitest";

import {
  createDisconnectConfirmation,
  verifyDisconnectConfirmation,
} from "../src/disconnect-confirmation";
import type { Env } from "../src/env";

const env = {
  TOKEN_ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
} as Env;
const accountId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const now = Date.UTC(2026, 8, 5, 1, 2, 3);

describe("disconnect cleanup confirmation", () => {
  it("accepts a short-lived account- and owner-bound confirmation", async () => {
    const token = await createDisconnectConfirmation(
      env,
      accountId,
      ownerId,
      now,
    );

    await expect(
      verifyDisconnectConfirmation(env, token, accountId, ownerId, now),
    ).resolves.toBe(true);
    expect(token).not.toContain(accountId);
    expect(token).not.toContain(ownerId);
  });

  it("rejects tampering, the wrong owner, and expiration", async () => {
    const token = await createDisconnectConfirmation(
      env,
      accountId,
      ownerId,
      now,
    );
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(
      verifyDisconnectConfirmation(env, tampered, accountId, ownerId, now),
    ).resolves.toBe(false);
    await expect(
      verifyDisconnectConfirmation(env, token, accountId, accountId, now),
    ).resolves.toBe(false);
    await expect(
      verifyDisconnectConfirmation(
        env,
        token,
        accountId,
        ownerId,
        now + 601_000,
      ),
    ).resolves.toBe(false);
  });
});
