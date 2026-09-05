// @vitest-environment jsdom

import type { Session } from "@supabase/supabase-js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccountsPage,
  type ConnectedAccountSummary,
} from "../src/pages/AccountsPage";

const mocks = vi.hoisted(() => ({
  auth: {
    demoMode: false,
    loading: false,
    session: null as Session | null,
  },
  apiRequest: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("../src/lib/api", () => ({
  apiRequest: (...arguments_: unknown[]) => mocks.apiRequest(...arguments_),
}));

const session = {
  access_token: "browser-test-session",
} as Session;

function account(
  platform: ConnectedAccountSummary["platform"],
  overrides: Partial<ConnectedAccountSummary> = {},
): ConnectedAccountSummary {
  return {
    id: `${platform}-account`,
    platform,
    username: `${platform}-owner`,
    connection_status: "connected",
    approval_state: "pending",
    stored_approval_state: "pending",
    requires_reconnect: false,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  mocks.auth.demoMode = false;
  mocks.auth.session = session;
  mocks.apiRequest.mockReset();
  window.history.replaceState({}, "", "/accounts");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("authoritative Connected Accounts UI", () => {
  it("renders an honest loading state", () => {
    mocks.apiRequest.mockReturnValue(new Promise(() => undefined));
    render(<AccountsPage />);

    expect(
      screen.getByText(/checking authoritative account state/i),
    ).toBeTruthy();
    expect(screen.getAllByText(/checking account/i)).toHaveLength(3);
  });

  it("reports an authentication failure without requesting account data", async () => {
    mocks.auth.session = null;
    render(<AccountsPage />);

    expect(
      await screen.findByText(/authenticated session is required/i),
    ).toBeTruthy();
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("reports an API failure without claiming that providers are disconnected", async () => {
    mocks.apiRequest.mockRejectedValue(new Error("Account API unavailable"));
    render(<AccountsPage />);

    expect(await screen.findByText("Account API unavailable")).toBeTruthy();
    expect(screen.getAllByText("State unavailable")).toHaveLength(3);
    expect(screen.queryByText("No server account found")).toBeNull();
  });

  it("renders an empty response as three independently disconnected providers", async () => {
    mocks.apiRequest.mockResolvedValue({ data: [] });
    render(<AccountsPage />);

    await waitFor(() =>
      expect(screen.getAllByText("No server account found")).toHaveLength(3),
    );
    expect(screen.getByRole("button", { name: "Connect TikTok" })).toBeTruthy();
  });

  it("renders TikTok connected only when the server reports it", async () => {
    mocks.apiRequest.mockResolvedValue({
      data: [account("tiktok", { metadata: { displayName: "TikTok Owner" } })],
    });
    render(<AccountsPage />);

    expect(await screen.findByText("TikTok Owner")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("Token not stored")).toBeNull();
  });

  it("keeps TikTok absent when only another provider is returned", async () => {
    mocks.apiRequest.mockResolvedValue({ data: [account("instagram")] });
    render(<AccountsPage />);

    await screen.findByText("@instagram-owner");
    expect(screen.getByRole("button", { name: "Connect TikTok" })).toBeTruthy();
  });

  it("renders multiple providers and independent approval states", async () => {
    mocks.apiRequest.mockResolvedValue({
      data: [
        account("instagram", { approval_state: "approved" }),
        account("tiktok"),
        account("youtube", {
          connection_status: "expired",
          requires_reconnect: true,
        }),
      ],
    });
    render(<AccountsPage />);

    await screen.findByText("@instagram-owner");
    expect(screen.getByText("@tiktok-owner")).toBeTruthy();
    expect(screen.getByText("@youtube-owner")).toBeTruthy();
    expect(
      screen.getByText("Current Worker approval flag is enabled"),
    ).toBeTruthy();
    expect(screen.getByText("Expired - reconnect required")).toBeTruthy();
  });

  it("shows current false launch gates despite stale stored approvals", async () => {
    mocks.apiRequest.mockResolvedValue({
      data: (["instagram", "tiktok", "youtube"] as const).map((platform) =>
        account(platform, {
          approval_state: "pending",
          stored_approval_state: "approved",
        }),
      ),
    });
    render(<AccountsPage />);

    expect(
      await screen.findAllByText("Current Worker approval flag is false"),
    ).toHaveLength(3);
    expect(screen.queryByText(/approval recorded by the server/i)).toBeNull();
  });

  it("treats the callback query as notification, refetches, and removes it", async () => {
    window.history.replaceState({}, "", "/accounts?connected=tiktok");
    mocks.apiRequest.mockResolvedValue({ data: [account("tiktok")] });
    render(<AccountsPage />);

    expect(
      await screen.findByText("TikTok connection confirmed by the server."),
    ).toBeTruthy();
    expect(mocks.apiRequest).toHaveBeenCalledWith("/api/accounts", session);
    expect(window.location.search).toBe("");
  });

  it("does not let a callback query manufacture a connected account", async () => {
    window.history.replaceState({}, "", "/accounts?connected=tiktok");
    mocks.apiRequest.mockResolvedValue({ data: [] });
    render(<AccountsPage />);

    expect(
      await screen.findByText(/server does not report a connected account/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect TikTok" })).toBeTruthy();
  });

  it("refetches on a hard remount and preserves only server state", async () => {
    mocks.apiRequest.mockResolvedValue({ data: [account("tiktok")] });
    const first = render(<AccountsPage />);
    await screen.findByText("@tiktok-owner");
    first.unmount();

    render(<AccountsPage />);
    await screen.findByText("@tiktok-owner");
    expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
  });

  it("never renders credential or encrypted-token material", async () => {
    mocks.apiRequest.mockResolvedValue({
      data: [
        {
          ...account("tiktok"),
          encrypted_access_token: "ciphertext-browser-sentinel",
          encrypted_refresh_token: "refresh-browser-sentinel",
          access_token_nonce: "nonce-browser-sentinel",
        },
      ],
    });
    const { container } = render(<AccountsPage />);
    await screen.findByText("@tiktok-owner");

    const output = container.textContent ?? "";
    expect(output).not.toContain("ciphertext-browser-sentinel");
    expect(output).not.toContain("refresh-browser-sentinel");
    expect(output).not.toContain("nonce-browser-sentinel");
  });

  it("requires confirmation before requesting provider revocation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.apiRequest.mockResolvedValueOnce({ data: [account("youtube")] });
    render(<AccountsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.apiRequest).toHaveBeenCalledTimes(1);
  });

  it("finishes local cleanup without repeating a successful provider revocation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.apiRequest
      .mockResolvedValueOnce({ data: [account("tiktok")] })
      .mockResolvedValueOnce({
        ok: false,
        providerRevoked: true,
        localCleanupPending: true,
        disconnectCleanup: {
          operationId: "durable-operation",
          state: "provider_revoked",
          expiresAt: "2099-01-01T00:00:00.000Z",
          providerRevoked: true,
          revocationUncertain: false,
        },
      })
      .mockResolvedValueOnce({
        data: [
          account("tiktok", {
            disconnect_cleanup: {
              operationId: "durable-operation",
              state: "provider_revoked",
              expiresAt: "2099-01-01T00:00:00.000Z",
              providerRevoked: true,
              revocationUncertain: false,
            },
          }),
        ],
      })
      .mockResolvedValueOnce({ ok: true, providerRevoked: true })
      .mockResolvedValueOnce({ data: [] });
    render(<AccountsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByText(/access was revoked.*confirm local cleanup/i),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm local cleanup" }),
    );

    await screen.findByText("TikTok was disconnected.");
    expect(mocks.apiRequest.mock.calls[1]).toMatchObject([
      "/api/accounts/tiktok-account",
      session,
      { method: "DELETE" },
    ]);
    expect(mocks.apiRequest.mock.calls[3]?.[0]).toBe(
      "/api/accounts/tiktok-account/disconnect/confirm",
    );
    expect(
      JSON.parse(String(mocks.apiRequest.mock.calls[3]?.[2]?.body)),
    ).toEqual({ operationId: "durable-operation" });
  });

  it("rehydrates pending cleanup after refresh and browser re-entry", async () => {
    mocks.apiRequest.mockResolvedValue({
      data: [
        account("instagram", {
          disconnect_cleanup: {
            operationId: "rehydrated-operation",
            state: "revocation_uncertain",
            expiresAt: "2099-01-01T00:00:00.000Z",
            providerRevoked: false,
            revocationUncertain: true,
          },
        }),
      ],
    });
    const first = render(<AccountsPage />);

    expect(
      await screen.findByRole("button", { name: "Confirm local cleanup" }),
    ).toBeTruthy();
    first.unmount();
    render(<AccountsPage />);
    expect(
      await screen.findByRole("button", { name: "Confirm local cleanup" }),
    ).toBeTruthy();
    expect(mocks.apiRequest).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost DELETE response from authoritative server state", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.apiRequest
      .mockResolvedValueOnce({ data: [account("youtube")] })
      .mockRejectedValueOnce(new Error("Response was lost"))
      .mockResolvedValueOnce({
        data: [
          account("youtube", {
            disconnect_cleanup: {
              operationId: "response-loss-operation",
              state: "revocation_started",
              expiresAt: "2099-01-01T00:00:00.000Z",
              providerRevoked: false,
              revocationUncertain: true,
            },
          }),
        ],
      });
    render(<AccountsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Response was lost")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm local cleanup" }),
    ).toBeTruthy();
    expect(mocks.apiRequest).toHaveBeenCalledTimes(3);
  });

  it("resumes a prepared disconnect before offering local cleanup", async () => {
    const prepared = account("tiktok", {
      disconnect_cleanup: {
        operationId: "prepared-operation",
        state: "prepared",
        expiresAt: "2099-01-01T00:00:00.000Z",
        providerRevoked: false,
        revocationUncertain: false,
      },
    });
    const revoked = account("tiktok", {
      disconnect_cleanup: {
        operationId: "prepared-operation",
        state: "provider_revoked",
        expiresAt: "2099-01-01T00:00:00.000Z",
        providerRevoked: true,
        revocationUncertain: false,
      },
    });
    mocks.apiRequest
      .mockResolvedValueOnce({ data: [prepared] })
      .mockResolvedValueOnce({
        ok: false,
        providerRevoked: true,
        localCleanupPending: true,
        disconnectCleanup: revoked.disconnect_cleanup,
      })
      .mockResolvedValueOnce({ data: [revoked] });
    render(<AccountsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Resume disconnect" }),
    );
    expect(
      await screen.findByRole("button", { name: "Confirm local cleanup" }),
    ).toBeTruthy();
    expect(mocks.apiRequest.mock.calls[1]).toMatchObject([
      "/api/accounts/tiktok-account",
      session,
      { method: "DELETE" },
    ]);
    expect(
      mocks.apiRequest.mock.calls.some(
        ([path]) => path === "/api/accounts/tiktok-account/disconnect/confirm",
      ),
    ).toBe(false);
  });

  it("renews an expired cleanup record without a browser-side revocation retry", async () => {
    mocks.apiRequest
      .mockResolvedValueOnce({
        data: [
          account("instagram", {
            disconnect_cleanup: {
              operationId: "expired-operation",
              state: "provider_revoked",
              expiresAt: "2000-01-01T00:00:00.000Z",
              providerRevoked: true,
              revocationUncertain: false,
            },
          }),
        ],
      })
      .mockResolvedValueOnce({
        ok: false,
        localCleanupPending: true,
        disconnectCleanup: {
          operationId: "renewed-operation",
          state: "provider_revoked",
          expiresAt: "2099-01-01T00:00:00.000Z",
          providerRevoked: true,
          revocationUncertain: false,
        },
      })
      .mockResolvedValueOnce({ ok: true, providerRevoked: true })
      .mockResolvedValueOnce({ data: [] });
    render(<AccountsPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Resume local cleanup" }),
    );
    await screen.findByText("Instagram was disconnected.");
    expect(mocks.apiRequest.mock.calls[1]).toMatchObject([
      "/api/accounts/instagram-account",
      session,
      { method: "DELETE" },
    ]);
    expect(
      JSON.parse(String(mocks.apiRequest.mock.calls[2]?.[2]?.body)),
    ).toEqual({ operationId: "renewed-operation" });
  });
});
