import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";

const developmentEnv = {
  ENVIRONMENT: "development",
  APP_URL: "https://postline.example.test",
} as Env;

describe("sensitive HTTP response hardening", () => {
  it("marks authenticated API responses as private and non-cacheable", async () => {
    const response = await app.request(
      "https://worker.example.test/api/accounts",
      undefined,
      developmentEnv,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("marks OAuth callback errors as private and non-cacheable", async () => {
    const response = await app.request(
      "https://worker.example.test/api/oauth/tiktok/callback",
      undefined,
      developmentEnv,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "missing_oauth_parameters",
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("keeps Wrangler invocation query-string redaction enabled", () => {
    const config = readFileSync(
      resolve(process.cwd(), "apps/worker/wrangler.toml"),
      "utf8",
    );
    expect(config).toMatch(
      /\[observability\][\s\S]*redact_query_string\s*=\s*true/,
    );
  });
});
