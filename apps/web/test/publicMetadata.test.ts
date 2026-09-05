import { describe, expect, it } from "vitest";

import { injectPublicMetadata } from "../src/lib/publicMetadata";

describe("public announcement metadata", () => {
  it("uses the validated installation origin for canonical and social URLs", () => {
    const rendered = injectPublicMetadata(
      '<link rel="canonical" href="__POSTLINE_APP_URL__" /><meta property="og:url" content="__POSTLINE_APP_URL__" />',
      "https://postline-owner.pages.dev",
    );

    expect(rendered).toContain(
      '<link rel="canonical" href="https://postline-owner.pages.dev" />',
    );
    expect(rendered).toContain(
      '<meta property="og:url" content="https://postline-owner.pages.dev" />',
    );
    expect(rendered).not.toContain("__POSTLINE_APP_URL__");
  });

  it("fails the build when the metadata placeholder is removed", () => {
    expect(() =>
      injectPublicMetadata("<html></html>", "https://postline.dev"),
    ).toThrow(/missing its public URL placeholder/);
  });
});
