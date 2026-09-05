import { afterEach, describe, expect, it, vi } from "vitest";

import { TikTokAdapter, TIKTOK_REQUIRED_SCOPES } from "../src";

const clientSecret = "client-secret-test-sentinel";
const accessToken = "access-token-test-sentinel";

function adapter(fetcher: typeof fetch) {
  return new TikTokAdapter(
    {
      clientKey: "client-key",
      clientSecret,
      contentPostingAudited: false,
    },
    fetcher,
  );
}

function validTokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: accessToken,
    refresh_token: "refresh-token-test-sentinel",
    open_id: "creator-id",
    expires_in: 86_400,
    refresh_expires_in: 31_536_000,
    scope: TIKTOK_REQUIRED_SCOPES.join(","),
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("TikTok OAuth response validation", () => {
  it("accepts a complete token response and preserves refresh expiry metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(validTokenResponse()), { status: 200 }),
      );
    const tokens = await adapter(fetcher).exchangeAuthorizationCode(
      "authorization-code",
      "https://worker.test/api/oauth/tiktok/callback",
    );

    expect(tokens.scopes).toEqual(TIKTOK_REQUIRED_SCOPES);
    expect(tokens.raw.refreshTokenExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects missing required scopes and malformed token responses", async () => {
    const missingScope = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify(validTokenResponse({ scope: "user.info.basic" })),
          { status: 200 },
        ),
      );
    await expect(
      adapter(missingScope).exchangeAuthorizationCode(
        "authorization-code",
        "https://worker.test/api/oauth/tiktok/callback",
      ),
    ).rejects.toMatchObject({ code: "missing_tiktok_scopes" });

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      adapter(malformed).exchangeAuthorizationCode(
        "authorization-code",
        "https://worker.test/api/oauth/tiktok/callback",
      ),
    ).rejects.toMatchObject({ code: "invalid_tiktok_oauth_response" });
  });
});

describe("TikTok token revocation", () => {
  it("uses the official endpoint, method, content type, and required fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await adapter(fetcher).disconnect(accessToken);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/revoke/");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_key")).toBe("client-key");
    expect(body.get("client_secret")).toBe(clientSecret);
    expect(body.get("token")).toBe(accessToken);
  });

  it("returns sanitized errors for provider rejection and network failure", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    for (const fetcher of [
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: `rejected ${clientSecret} ${accessToken}`,
          }),
          { status: 400 },
        ),
      ),
      vi.fn<typeof fetch>().mockRejectedValue(new Error("network down")),
    ]) {
      let thrown: unknown;
      try {
        await adapter(fetcher).disconnect(accessToken);
      } catch (reason) {
        thrown = reason;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("TikTok token revocation failed.");
      const output = JSON.stringify(thrown);
      expect(output).not.toContain(clientSecret);
      expect(output).not.toContain(accessToken);
    }
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects a non-empty success body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      );
    await expect(
      adapter(fetcher).disconnect(accessToken),
    ).rejects.toMatchObject({ code: "tiktok_revoke_failed" });
  });
});
