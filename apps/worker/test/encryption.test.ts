import { describe, expect, it } from "vitest";

import {
  encryptionKeyResolver,
  historicalEncryptionKeyBinding,
} from "../src/encryption";
import type { Env } from "../src/env";

describe("Worker encryption key resolution", () => {
  it("uses the current key only for its declared version", () => {
    const resolve = encryptionKeyResolver({
      TOKEN_ENCRYPTION_KEY: "current-key",
      TOKEN_ENCRYPTION_KEY_VERSION: "v2",
    } as Env);

    expect(resolve("v2")).toBe("current-key");
    expect(resolve("v1")).toBeUndefined();
  });

  it("resolves historical bindings by a bounded operator convention", () => {
    const resolve = encryptionKeyResolver({
      TOKEN_ENCRYPTION_KEY: "current-key",
      TOKEN_ENCRYPTION_KEY_VERSION: "v2",
      TOKEN_ENCRYPTION_KEY_V1: "historical-key",
    } as Env);

    expect(historicalEncryptionKeyBinding("v1")).toBe(
      "TOKEN_ENCRYPTION_KEY_V1",
    );
    expect(resolve("v1")).toBe("historical-key");
    expect(resolve("../../unsafe")).toBeUndefined();
  });
});
