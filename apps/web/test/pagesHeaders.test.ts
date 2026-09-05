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
    expect(headers).toContain(
      "script-src 'self' https://challenges.cloudflare.com",
    );
    expect(headers).toContain("frame-src https://challenges.cloudflare.com");
    expect(headers).not.toContain("https://challenges.cloudflare.com/");
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
