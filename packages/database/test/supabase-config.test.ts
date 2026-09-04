import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync(
  resolve(process.cwd(), "supabase/config.toml"),
  "utf8",
);

function section(name: string): string {
  const marker = `[${name}]`;
  const start = config.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  const remainder = config.slice(start + marker.length);
  const next = remainder.search(/^\[/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

describe("local Supabase Auth defaults", () => {
  it("keeps direct signup and anonymous authentication disabled", () => {
    expect(section("auth")).toMatch(/^enable_signup = false$/m);
    expect(section("auth")).toMatch(/^enable_anonymous_sign_ins = false$/m);
    expect(section("auth.email")).toMatch(/^enable_signup = false$/m);
  });

  it("keeps email OTP requests at least sixty seconds apart", () => {
    expect(section("auth.email")).toMatch(/^max_frequency = "60s"$/m);
  });
});
