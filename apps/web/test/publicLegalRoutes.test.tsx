import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../src/App";

afterEach(() => vi.unstubAllEnvs());

describe("public legal routes", () => {
  it.each([
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Use"],
    ["/data-deletion", "Data Deletion Instructions"],
  ])("renders %s without an authentication provider", (route, heading) => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );

    expect(html).toContain(`<h1>${heading}</h1>`);
    expect(html).not.toMatch(/customizable template|policy template/i);
  });

  it("renders the configured operator and accessible contact link", () => {
    vi.stubEnv("VITE_DEMO_MODE", "false");
    vi.stubEnv("VITE_OPERATOR_NAME", "Independent Postline");
    vi.stubEnv("VITE_PUBLIC_CONTACT_EMAIL", "legal@independent-postline.dev");

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/privacy"]}>
        <App />
      </MemoryRouter>,
    );

    expect(html).toContain("Independent Postline");
    expect(html).toContain("legal@independent-postline.dev");
    expect(html).toContain('href="mailto:legal@independent-postline.dev"');
    expect(html).toContain(
      'aria-label="Email Independent Postline at legal@independent-postline.dev"',
    );
  });
});
