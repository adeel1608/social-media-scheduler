import { describe, expect, it } from "vitest";

import {
  authorizeOwner,
  decryptSecret,
  encryptSecret,
  isTokenExpired,
  redactSecrets,
  stableIdempotencyKey,
} from "../src";

const key = Buffer.alloc(32, 7).toString("base64");

describe("token encryption", () => {
  it("encrypts with a random nonce and decrypts", async () => {
    const first = await encryptSecret("access-token-value", key, "v3");
    const second = await encryptSecret("access-token-value", key, "v3");
    expect(first.ciphertext).not.toBe("access-token-value");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.keyVersion).toBe("v3");
    await expect(
      decryptSecret(first, (version) => (version === "v3" ? key : undefined)),
    ).resolves.toBe("access-token-value");
  });

  it("rejects the wrong key", async () => {
    const encrypted = await encryptSecret("secret", key);
    await expect(
      decryptSecret(encrypted, (version) =>
        version === "v1" ? Buffer.alloc(32, 8).toString("base64") : undefined,
      ),
    ).rejects.toThrow("could not be decrypted");
  });

  it("resolves historical versions explicitly and supports rotation rollback", async () => {
    const nextKey = Buffer.alloc(32, 9).toString("base64");
    const beforeRotation = await encryptSecret("old-value", key, "v1");
    const afterRotation = await encryptSecret("new-value", nextKey, "v2");
    const rotatedKeys = (version: string) =>
      ({ v1: key, v2: nextKey })[version];

    await expect(decryptSecret(beforeRotation, rotatedKeys)).resolves.toBe(
      "old-value",
    );
    await expect(decryptSecret(afterRotation, rotatedKeys)).resolves.toBe(
      "new-value",
    );

    const rolledBackKeys = (version: string) =>
      ({ v1: key, v2: nextKey })[version];
    await expect(decryptSecret(afterRotation, rolledBackKeys)).resolves.toBe(
      "new-value",
    );
  });

  it("fails closed when a stored key version is unavailable", async () => {
    const encrypted = await encryptSecret("must-not-leak", key, "v7");
    await expect(
      decryptSecret(encrypted, () => undefined),
    ).rejects.toMatchObject({
      code: "key_unavailable",
      message: "The required encryption key version is unavailable.",
    });
  });

  it("sanitizes malformed ciphertext and authentication failures", async () => {
    const encrypted = await encryptSecret("sensitive-plaintext", key, "v1");
    const resolver = () => key;
    for (const candidate of [
      { ...encrypted, ciphertext: "not-base64" },
      { ...encrypted, nonce: Buffer.alloc(12, 4).toString("base64") },
    ]) {
      await expect(decryptSecret(candidate, resolver)).rejects.toMatchObject({
        code: "decryption_failed",
        message: "The encrypted value could not be decrypted.",
      });
    }
  });
});

describe("owner authorization", () => {
  it("allows only the configured owner and denies expired sessions", () => {
    expect(
      authorizeOwner(
        { id: "1", email: "Owner@Example.com" },
        "owner@example.com",
      ).authorized,
    ).toBe(true);
    expect(
      authorizeOwner(
        { id: "2", email: "other@example.com" },
        "owner@example.com",
      ),
    ).toMatchObject({ authorized: false, status: 403 });
    expect(authorizeOwner(null, "owner@example.com")).toMatchObject({
      authorized: false,
      status: 401,
    });
    expect(
      authorizeOwner(
        { id: "1", email: "owner@example.com", expiresAt: 10 },
        "owner@example.com",
        11,
      ),
    ).toMatchObject({ authorized: false, status: 401 });
  });

  it("detects expired platform tokens", () => {
    expect(isTokenExpired(new Date(Date.now() - 1_000).toISOString())).toBe(
      true,
    );
    expect(isTokenExpired(new Date(Date.now() + 3_600_000).toISOString())).toBe(
      false,
    );
  });
});

describe("safe diagnostics", () => {
  it("redacts nested secrets, bearer tokens, and signed URLs", () => {
    const redacted = redactSecrets({
      accessToken: "abc",
      nested: {
        message: "Bearer abc.def",
        url: "https://x.test/a?signature=very-secret",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("abc.def");
    expect(JSON.stringify(redacted)).not.toContain("very-secret");
    expect(redacted).toMatchObject({ accessToken: "[REDACTED]" });
  });

  it("redacts OAuth queries, PKCE values, cookies, and Error messages", () => {
    const redacted = redactSecrets({
      callback:
        "https://worker.test/callback?code=oauth-code&state=oauth-state&code_verifier=pkce-value",
      headers: "Cookie: session=cookie-value\nAuthorization: Basic credential",
      error: new Error(
        "Failed https://worker.test/callback?code=oauth-code&state=oauth-state",
      ),
    });
    const output = JSON.stringify(redacted);
    for (const sensitive of [
      "oauth-code",
      "oauth-state",
      "pkce-value",
      "cookie-value",
      "Basic credential",
    ]) {
      expect(output).not.toContain(sensitive);
    }
    expect(output).toContain("code=[REDACTED]");
    expect(output).toContain("state=[REDACTED]");
  });

  it("creates stable versioned idempotency keys", () => {
    expect(stableIdempotencyKey("p", "t")).toBe(stableIdempotencyKey("p", "t"));
    expect(stableIdempotencyKey("p", "t", 2)).not.toBe(
      stableIdempotencyKey("p", "t"),
    );
  });
});
