import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const authContext = readFileSync(
  resolve(process.cwd(), "apps/web/src/context/AuthContext.tsx"),
  "utf8",
);

describe("browser Auth hardening", () => {
  it("never creates a user during magic-link sign-in", () => {
    expect(authContext).toMatch(/shouldCreateUser:\s*false/);
    expect(authContext).toMatch(/captchaToken,/);
    expect(authContext).not.toMatch(/\.auth\.signUp\s*\(/);
  });

  it("does not expose raw Supabase Auth errors in the UI", () => {
    expect(authContext).not.toContain("error.message");
    expect(authContext).toContain("The sign-in link could not be sent.");
  });

  it("uses Supabase password authentication with CAPTCHA for the reviewer", () => {
    expect(authContext).toMatch(/\.auth\.signInWithPassword\s*\(/);
    expect(authContext).toMatch(/options:\s*\{\s*captchaToken\s*\}/);
    expect(authContext).toContain("VITE_META_REVIEW_MODE");
    expect(authContext).toContain('body?.role !== "meta_reviewer"');
    expect(authContext).not.toMatch(/\.auth\.signUp\s*\(/);
  });

  it("attempts bounded server OAuth cancellation without trapping local sign-out", () => {
    expect(authContext).toContain("await cancelPendingOAuth(session)");
    expect(authContext).toMatch(/catch\s*\{[\s\S]*Best effort only/);
    expect(authContext).toMatch(
      /finally\s*\{[\s\S]*setSession\(null\)[\s\S]*setAccessRole\(null\)/,
    );
  });
});
