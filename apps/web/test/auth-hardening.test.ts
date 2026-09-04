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
    expect(authContext).not.toMatch(/\.auth\.signUp\s*\(/);
  });

  it("does not expose raw Supabase Auth errors in the UI", () => {
    expect(authContext).not.toContain("error.message");
    expect(authContext).toContain("The sign-in link could not be sent.");
  });
});
