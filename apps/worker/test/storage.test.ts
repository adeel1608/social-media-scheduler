import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { signedDeliveryUrl, verifyDeliveryRequest } from "../src/storage";

function signingEnv(): Env {
  return {
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(7)),
    ),
    R2_PUBLIC_DELIVERY_HOST: "https://media.example.test",
  } as Env;
}

describe("private provider delivery URLs", () => {
  it("signs an owner-domain URL and verifies its opaque object key", async () => {
    const env = signingEnv();
    const signed = new URL(
      await signedDeliveryUrl(env, "owner-id/opaque asset.mp4", 300),
    );

    expect(signed.origin).toBe("https://media.example.test");
    expect(signed.pathname).not.toContain("opaque");
    expect(
      await verifyDeliveryRequest(
        env,
        signed.pathname.split("/").pop()!,
        signed.searchParams.get("expires") ?? undefined,
        signed.searchParams.get("signature") ?? undefined,
      ),
    ).toBe("owner-id/opaque asset.mp4");
  });

  it("rejects tampered and expired delivery signatures", async () => {
    const env = signingEnv();
    const signed = new URL(await signedDeliveryUrl(env, "asset.jpg"));
    const key = signed.pathname.split("/").pop()!;

    expect(
      await verifyDeliveryRequest(
        env,
        key,
        signed.searchParams.get("expires") ?? undefined,
        `${signed.searchParams.get("signature")}x`,
      ),
    ).toBeNull();
    expect(
      await verifyDeliveryRequest(env, key, "1000000000", "invalid"),
    ).toBeNull();
  });
});
