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
    await expect(decryptSecret(first, key)).resolves.toBe("access-token-value");
  });

  it("rejects the wrong key", async () => {
    const encrypted = await encryptSecret("secret", key);
    await expect(
      decryptSecret(encrypted, Buffer.alloc(32, 8).toString("base64")),
    ).rejects.toThrow();
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

  it("creates stable versioned idempotency keys", () => {
    expect(stableIdempotencyKey("p", "t")).toBe(stableIdempotencyKey("p", "t"));
    expect(stableIdempotencyKey("p", "t", 2)).not.toBe(
      stableIdempotencyKey("p", "t"),
    );
  });
});
