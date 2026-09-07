import { encryptSecret } from "@scheduler/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";
import {
  hashOAuthBrowserBinding,
  oauthHash,
  type OAuthBindingRecord,
} from "../src/oauth-binding";

const ownerId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const state = "state-value-with-enough-random-looking-bytes-1234";
const binding = "binding-value-with-enough-random-looking-bytes-12";
const encryptionKey = btoa("A".repeat(32));

const environment = {
  ENVIRONMENT: "development",
  APP_URL: "https://postline.example.test",
  WORKER_PUBLIC_URL: "https://worker.example.test",
  OWNER_EMAIL: "owner@postline.dev",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "public-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  TOKEN_ENCRYPTION_KEY: encryptionKey,
  TOKEN_ENCRYPTION_KEY_VERSION: "v1",
  META_APP_ID: "synthetic-app-id",
  META_APP_SECRET: "synthetic-app-secret",
  META_REDIRECT_URI: "https://worker.example.test/api/oauth/instagram/callback",
  META_GRAPH_VERSION: "v23.0",
  META_APP_REVIEW_APPROVED: "false",
  META_REVIEW_MODE: "false",
} as Env;

afterEach(() => vi.unstubAllGlobals());

async function record(
  overrides: Partial<OAuthBindingRecord & Record<string, unknown>> = {},
) {
  const encrypted = await encryptSecret("verifier", encryptionKey, "v1");
  const base: OAuthBindingRecord & Record<string, unknown> = {
    id: "33333333-3333-4333-8333-333333333333",
    state_hash: await oauthHash(state),
    owner_id: ownerId,
    authorization_context: "owner",
    authorization_generation: null,
    auth_session_id: sessionId,
    initiating_email: "owner@postline.dev",
    redirect_uri: environment.META_REDIRECT_URI,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    encrypted_pkce_verifier: encrypted.ciphertext,
    pkce_nonce: encrypted.nonce,
    encryption_key_version: encrypted.keyVersion,
  };
  const original = { ...base };
  const value = { ...base, ...overrides };
  value.browser_binding_hash = await hashOAuthBrowserBinding(binding, original);
  return value;
}

function callbackRequest(cookie = binding) {
  return new Request(
    `https://worker.example.test/api/oauth/instagram/callback?code=synthetic-code&state=${encodeURIComponent(state)}`,
    {
      headers: cookie
        ? { Cookie: `__Host-postline-oauth-instagram=${cookie}` }
        : {},
    },
  );
}

function callbackFetch(oauthRecord: Record<string, unknown>, consume = true) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/rest/v1/oauth_states?"))
      return Response.json([oauthRecord]);
    if (url.endsWith("/rest/v1/rpc/consume_bound_oauth_state"))
      return Response.json(consume ? [oauthRecord] : []);
    if (url.endsWith("/rest/v1/rpc/persist_bound_oauth_account"))
      return Response.json({ id: "account-id" });
    if (url === "https://api.instagram.com/oauth/access_token")
      return Response.json({
        access_token: "synthetic-short-token",
        user_id: 123,
      });
    if (url.startsWith("https://graph.instagram.com/access_token"))
      return Response.json({
        access_token: "synthetic-long-token",
        expires_in: 3600,
      });
    if (url.startsWith("https://graph.instagram.com/v23.0/me"))
      return Response.json({
        id: "remote-123",
        username: "review-fixture",
        account_type: "BUSINESS",
      });
    throw new Error(
      `unexpected request ${new URL(url).origin}${new URL(url).pathname}`,
    );
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

describe("OAuth browser and session binding", () => {
  it("completes once in the same browser and persists only after exchange", async () => {
    const fixture = await record();
    const { calls } = callbackFetch(fixture);
    const response = await app.fetch(callbackRequest(), environment);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      calls.filter(
        (url) => url === "https://api.instagram.com/oauth/access_token",
      ),
    ).toHaveLength(1);
    expect(
      calls.filter((url) =>
        url.endsWith("/rest/v1/rpc/persist_bound_oauth_account"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["missing cookie", "", {}],
    ["wrong cookie", "other-binding-value-with-enough-random-bytes-123", {}],
    [
      "expired state",
      binding,
      { expires_at: new Date(Date.now() - 1_000).toISOString() },
    ],
    [
      "different session",
      binding,
      { auth_session_id: "44444444-4444-4444-8444-444444444444" },
    ],
    [
      "different identity",
      binding,
      { owner_id: "55555555-5555-4555-8555-555555555555" },
    ],
    ["different context", binding, { authorization_context: "meta_review" }],
  ])(
    "rejects %s before exchange and persistence",
    async (_name, cookie, change) => {
      const fixture = await record(change as Partial<OAuthBindingRecord>);
      const { calls } = callbackFetch(fixture);
      const response = await app.fetch(
        callbackRequest(cookie as string),
        environment,
      );
      expect([400, 403]).toContain(response.status);
      expect(calls.some((url) => url.includes("instagram.com"))).toBe(false);
      expect(
        calls.some((url) => url.endsWith("/persist_bound_oauth_account")),
      ).toBe(false);
    },
  );

  it("rejects an atomically consumed/replayed state without exchange or persistence", async () => {
    const fixture = await record();
    const { calls } = callbackFetch(fixture, false);
    const response = await app.fetch(callbackRequest(), environment);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "oauth_state_already_consumed",
    });
    expect(calls.some((url) => url.includes("instagram.com"))).toBe(false);
    expect(
      calls.some((url) => url.endsWith("/persist_bound_oauth_account")),
    ).toBe(false);
  });

  it("starts with a session-bound HttpOnly cookie and never puts the bearer token in a URL", async () => {
    const exp = Math.floor(Date.now() / 1_000) + 600;
    const payload = btoa(
      JSON.stringify({ session_id: sessionId, exp }),
    ).replace(/=/g, "");
    const token = `header.${payload}.signature`;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/auth/v1/user"))
          return Response.json({ id: ownerId, email: "owner@postline.dev" });
        if (url.endsWith("/rest/v1/rpc/consume_rate_limit"))
          return Response.json(true);
        if (url.endsWith("/rest/v1/oauth_states")) return Response.json([]);
        throw new Error("unexpected request");
      }),
    );
    const response = await app.request(
      "https://worker.example.test/api/oauth/instagram/start",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      environment,
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(calls.every((url) => !url.includes(token))).toBe(true);
  });
});
