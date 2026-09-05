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
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    sendMagicLink: mocks.sendMagicLink,
    session: null,
    demoMode: false,
  }),
}));

let options: TurnstileRenderOptions | undefined;
let reset: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
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
