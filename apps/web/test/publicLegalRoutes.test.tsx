import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../src/App";
import { AuthProvider } from "../src/context/AuthContext";

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

  it("renders a labelled owner login form with status semantics", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(html).toContain('<label for="email">Email address</label>');
    expect(html).toContain('aria-describedby="login-help"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('type="submit"');
  });
});
