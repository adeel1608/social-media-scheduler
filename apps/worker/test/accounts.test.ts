import { describe, expect, it } from "vitest";

import { sanitizeConnectedAccount } from "../src/accounts";

describe("connected account response sanitization", () => {
  it("returns only the browser-safe account contract", () => {
    const result = sanitizeConnectedAccount({
      id: "account-1",
      platform: "tiktok",
      username: "owner",
      connection_status: "connected",
      approval_state: "pending",
      metadata: {
        displayName: "Owner",
        accountType: "Creator",
        refreshTokenExpiresAt: "2099-01-01T00:00:00Z",
        nestedCredential: "must-not-render",
      },
      encrypted_access_token: "ciphertext-sentinel",
      encrypted_refresh_token: "refresh-ciphertext-sentinel",
      access_token_nonce: "nonce-sentinel",
      scopes: ["video.publish"],
      token_expires_at: "2099-01-01T00:00:00Z",
    });

    expect(result).toEqual({
      id: "account-1",
      platform: "tiktok",
      username: "owner",
      connection_status: "connected",
      approval_state: "pending",
      requires_reconnect: false,
      metadata: { displayName: "Owner", accountType: "Creator" },
    });
    const output = JSON.stringify(result);
    for (const hidden of [
      "ciphertext-sentinel",
      "refresh-ciphertext-sentinel",
      "nonce-sentinel",
      "refreshTokenExpiresAt",
      "video.publish",
    ]) {
      expect(output).not.toContain(hidden);
    }
  });

  it("marks non-connected server states as requiring reconnection", () => {
    for (const connection_status of [
      "expired",
      "revoked",
      "error",
      "disconnected",
    ]) {
      expect(
        sanitizeConnectedAccount({
          id: "account-1",
          platform: "tiktok",
          username: null,
          connection_status,
          approval_state: "pending",
          metadata: {},
        }),
      ).toMatchObject({ requires_reconnect: true });
    }
  });

  it("exposes only owner-safe durable cleanup state", () => {
    const result = sanitizeConnectedAccount({
      id: "account-1",
      platform: "instagram",
      username: "owner",
      connection_status: "connected",
      approval_state: "approved",
      metadata: {},
      disconnect_cleanup: {
        account_id: "account-1",
        owner_id: "owner-secret-id",
        operation_id: "operation-1",
        state: "revocation_uncertain",
        expires_at: "2026-09-05T02:00:00.000Z",
        provider_request_sent_at: "2026-09-05T01:00:00.000Z",
      },
    });

    expect(result?.disconnect_cleanup).toEqual({
      operationId: "operation-1",
      state: "revocation_uncertain",
      expiresAt: "2026-09-05T02:00:00.000Z",
      providerRevoked: false,
      revocationUncertain: true,
    });
    expect(JSON.stringify(result)).not.toContain("owner-secret-id");
    expect(JSON.stringify(result)).not.toContain("provider_request_sent_at");
  });

  it("drops malformed account rows instead of guessing", () => {
    expect(
      sanitizeConnectedAccount({
        id: "account-1",
        platform: "unknown",
        connection_status: "connected",
        approval_state: "approved",
      }),
    ).toBeNull();
  });
});
