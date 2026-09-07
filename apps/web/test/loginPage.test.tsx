// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnstileRenderOptions } from "../src/lib/turnstile";
import { LoginPage } from "../src/pages/LoginPage";

const mocks = vi.hoisted(() => ({
  sendMagicLink: vi.fn(),
  signInMetaReviewer: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    sendMagicLink: mocks.sendMagicLink,
    signInMetaReviewer: mocks.signInMetaReviewer,
    session: null,
    demoMode: false,
    accessRole: null,
  }),
}));

let options: TurnstileRenderOptions | undefined;
let reset: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
  vi.stubEnv("VITE_META_REVIEW_MODE", "false");
  window.history.replaceState({}, "", "/login");
  options = undefined;
  reset = vi.fn();
  window.turnstile = {
    render: vi.fn((_container, nextOptions) => {
      options = nextOptions;
      return "login-widget";
    }),
    reset,
    remove: vi.fn(),
  };
  mocks.sendMagicLink.mockReset();
  mocks.sendMagicLink.mockResolvedValue({});
  mocks.signInMetaReviewer.mockReset();
  mocks.signInMetaReviewer.mockResolvedValue({});
});

describe("Meta reviewer login", () => {
  it("is unavailable by default", () => {
    window.history.replaceState({}, "", "/login?review=meta");
    render(<LoginPage />);

    expect(screen.getByRole("alert").textContent).toContain("not enabled");
    expect(
      screen
        .getByRole("button", { name: /send magic link/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByLabelText("Temporary password")).toBeNull();
  });

  it("passes email, password, and CAPTCHA only through the password flow", async () => {
    vi.stubEnv("VITE_META_REVIEW_MODE", "true");
    window.history.replaceState({}, "", "/login?review=meta");
    render(<LoginPage />);
    await waitFor(() => expect(options).toBeDefined());
    act(() => options?.callback("verified-review-token"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "reviewer@postline.dev" },
    });
    fireEvent.change(screen.getByLabelText("Temporary password"), {
      target: { value: "temporary-review-password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /sign in for meta review/i }),
    );

    await waitFor(() =>
      expect(mocks.signInMetaReviewer).toHaveBeenCalledWith(
        "reviewer@postline.dev",
        "temporary-review-password",
        "verified-review-token",
      ),
    );
    expect(mocks.sendMagicLink).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith("login-widget");
    expect(options?.action).toBe("meta_reviewer_login");
  });

  it("shows the same generic error for rejected reviewer credentials", async () => {
    vi.stubEnv("VITE_META_REVIEW_MODE", "true");
    window.history.replaceState({}, "", "/login?review=meta");
    mocks.signInMetaReviewer.mockResolvedValue({
      error: "The email or password could not be verified.",
    });
    render(<LoginPage />);
    await waitFor(() => expect(options).toBeDefined());
    act(() => options?.callback("verified-review-token"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "unknown@postline.dev" },
    });
    fireEvent.change(screen.getByLabelText("Temporary password"), {
      target: { value: "incorrect-password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /sign in for meta review/i }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not be verified",
    );
    expect(reset).toHaveBeenCalledWith("login-widget");
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete window.turnstile;
});

describe("owner login", () => {
  it("passes the verified token to Supabase auth and resets after the request", async () => {
    render(<LoginPage />);
    const submit = screen.getByRole("button", { name: /send magic link/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(options).toBeDefined());

    act(() => options?.callback("verified-login-token"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "owner@postline.dev" },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mocks.sendMagicLink).toHaveBeenCalledWith(
        "owner@postline.dev",
        "verified-login-token",
      ),
    );
    expect(reset).toHaveBeenCalledWith("login-widget");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Check your inbox",
    );
  });

  it("shows a safe error and resets the challenge after a rejected request", async () => {
    mocks.sendMagicLink.mockResolvedValue({
      error:
        "The sign-in link could not be sent. Check the email and try again later.",
    });
    render(<LoginPage />);
    await waitFor(() => expect(options).toBeDefined());
    act(() => options?.callback("verified-login-token"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "owner@postline.dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send magic link/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not be sent",
    );
    expect(reset).toHaveBeenCalledWith("login-widget");
  });

  it("fails closed when the public site key is not configured", () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");
    render(<LoginPage />);

    expect(screen.getByRole("alert").textContent).toContain("not configured");
    expect(
      (
        screen.getByRole("button", {
          name: /send magic link/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mocks.sendMagicLink).not.toHaveBeenCalled();
  });
});
