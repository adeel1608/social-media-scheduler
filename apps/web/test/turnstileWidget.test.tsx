// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TurnstileWidget } from "../src/components/TurnstileWidget";
import {
  TURNSTILE_SCRIPT_URL,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from "../src/lib/turnstile";

let options: TurnstileRenderOptions | undefined;
let api: TurnstileApi;

beforeEach(() => {
  options = undefined;
  api = {
    render: vi.fn((_container, nextOptions) => {
      options = nextOptions;
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = api;
});

afterEach(() => {
  cleanup();
  delete window.turnstile;
});

describe("owner login Turnstile challenge", () => {
  it("loads Cloudflare's exact explicit-rendering script URL", () => {
    expect(TURNSTILE_SCRIPT_URL).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    );
  });

  it("provides an accessible challenge and returns only verified tokens", async () => {
    const onTokenChange = vi.fn();
    render(
      <TurnstileWidget
        siteKey="1x00000000000000000000AA"
        onTokenChange={onTokenChange}
      />,
    );

    expect(
      screen.getByRole("group", { name: "Security verification" }),
    ).toBeTruthy();
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    act(() => options?.callback("verified-browser-token"));
    expect(onTokenChange).toHaveBeenLastCalledWith("verified-browser-token");
  });

  it("clears verification and exposes an accessible provider error", async () => {
    const onTokenChange = vi.fn();
    render(
      <TurnstileWidget
        siteKey="1x00000000000000000000AA"
        onTokenChange={onTokenChange}
      />,
    );
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    act(() => options?.["error-callback"]());

    expect(onTokenChange).toHaveBeenLastCalledWith("");
    expect(screen.getByRole("alert").textContent).toContain("failed to verify");
  });

  it("fails closed with a clear configuration error when the site key is absent", () => {
    const onTokenChange = vi.fn();
    render(<TurnstileWidget siteKey="" onTokenChange={onTokenChange} />);

    expect(screen.getByRole("alert").textContent).toContain("not configured");
    expect(onTokenChange).toHaveBeenCalledWith("");
    expect(api.render).not.toHaveBeenCalled();
  });
});
