import { describe, expect, it } from "vitest";

import { createCloudflarePagesHeaders } from "../src/lib/pagesHeaders";

describe("Cloudflare Pages security headers", () => {
  it("restricts browser connections to configured services and UploadThing ingest", () => {
    const headers = createCloudflarePagesHeaders({
      appUrl: "https://postline.pages.dev",
      apiUrl: "https://postline-api.workers.dev",
      supabaseUrl: "https://project.supabase.co",
      supabaseAnonKey: "public-key-not-rendered",
      turnstileSiteKey: "1x00000000000000000000AA",
      identity: {
        operatorName: "Postline",
        contactEmail: "owner@postline.dev",
      },
    });

    expect(headers).toContain(
      "connect-src 'self' https://postline-api.workers.dev https://project.supabase.co https://*.ingest.uploadthing.com",
    );
    expect(headers).not.toMatch(/connect-src[^;\n]*\shttps:(?:\s|;)/);
    expect(headers).not.toContain("public-key-not-rendered");
    const directives = contentSecurityPolicyDirectives(headers);
    expect(directives.get("script-src")).toEqual([
      "'self'",
      "https://challenges.cloudflare.com",
    ]);
    expect(directives.get("frame-src")).toEqual([
      "https://challenges.cloudflare.com",
    ]);
    expect(headers).toContain("frame-ancestors 'none'");
  });

  it("deduplicates a same-origin API and Supabase endpoint", () => {
    const headers = createCloudflarePagesHeaders({
      appUrl: "https://postline.example.dev",
      apiUrl: "https://services.example.dev",
      supabaseUrl: "https://services.example.dev",
      supabaseAnonKey: "public-key-not-rendered",
      turnstileSiteKey: "1x00000000000000000000AA",
      identity: {
        operatorName: "Postline",
        contactEmail: "owner@postline.dev",
      },
    });

    expect(headers.match(/https:\/\/services\.example\.dev/g)).toHaveLength(1);
  });
});

function contentSecurityPolicyDirectives(headers: string) {
  const policy = headers.match(/Content-Security-Policy: ([^\r\n]+)/)?.[1];
  if (!policy) throw new Error("Content-Security-Policy header is missing");
  return new Map(
    policy.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );
}
