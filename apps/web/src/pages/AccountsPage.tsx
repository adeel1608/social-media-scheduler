import type { Platform } from "@scheduler/shared";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

export interface ConnectedAccountSummary {
  id: string;
  platform: Platform;
  username: string | null;
  connection_status:
    "connected" | "expired" | "revoked" | "error" | "disconnected";
  approval_state: "approved" | "pending" | "not_required" | "rejected";
  requires_reconnect: boolean;
  metadata: {
    displayName?: string;
    accountType?: string;
  };
  disconnect_cleanup?: {
    operationId: string;
    state:
      | "prepared"
      | "revocation_started"
      | "provider_revoked"
      | "revocation_uncertain";
    expiresAt: string;
    providerRevoked: boolean;
    revocationUncertain: boolean;
  };
}

const providerDetails: Array<{ platform: Platform; type: string }> = [
  { platform: "instagram", type: "Professional Instagram account" },
  { platform: "tiktok", type: "TikTok Content Posting API" },
  { platform: "youtube", type: "YouTube channel" },
];

function providerLabel(platform: Platform): string {
  return platform === "tiktok"
    ? "TikTok"
    : platform === "youtube"
      ? "YouTube"
      : "Instagram";
}

function accountStatus(account: ConnectedAccountSummary): string {
  return {
    connected: "Connected",
    expired: "Expired - reconnect required",
    revoked: "Revoked - reconnect required",
    error: "Connection error - reconnect required",
    disconnected: "Disconnected",
  }[account.connection_status];
}

function approvalStatus(account: ConnectedAccountSummary): string {
  return {
    approved: "Approval recorded by the server",
    pending: "Provider approval pending",
    not_required: "No provider review required",
    rejected: "Provider approval rejected",
  }[account.approval_state];
}

function removeCallbackNotification(): Platform | null {
  const url = new URL(window.location.href);
  const value = url.searchParams.get("connected");
  const platform = providerDetails.some((item) => item.platform === value)
    ? (value as Platform)
    : null;
  if (url.searchParams.has("connected")) {
    url.searchParams.delete("connected");
    window.history.replaceState(
      {},
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  return platform;
}

export function AccountsPage() {
  const { demoMode, loading: authenticationLoading, session } = useAuth();
  const [accounts, setAccounts] = useState<ConnectedAccountSummary[]>([]);
  const [loading, setLoading] = useState(!demoMode);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState(
    demoMode
      ? "Demonstration mode does not read or change provider connections."
      : "",
  );

  const refreshAccounts = useCallback(
    async (callbackPlatform?: Platform | null) => {
      if (!session) {
        setLoading(false);
        setError("Your authenticated session is required to load accounts.");
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await apiRequest<{ data: ConnectedAccountSummary[] }>(
          "/api/accounts",
          session,
        );
        setAccounts(result.data);
        if (callbackPlatform) {
          const confirmed = result.data.some(
            (account) =>
              account.platform === callbackPlatform &&
              account.connection_status === "connected",
          );
          setMessage(
            confirmed
              ? `${providerLabel(callbackPlatform)} connection confirmed by the server.`
              : `${providerLabel(callbackPlatform)} returned to Postline, but the server does not report a connected account.`,
          );
        }
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Connected accounts could not be loaded.",
        );
      } finally {
        setLoading(false);
      }
    },
    [session],
  );

  useEffect(() => {
    if (demoMode || authenticationLoading) return;
    const callbackPlatform = removeCallbackNotification();
    void refreshAccounts(callbackPlatform);
  }, [authenticationLoading, demoMode, refreshAccounts]);

  async function connect(platform: Platform) {
    setWorking(`connect:${platform}`);
    if (demoMode || !session) {
      setMessage(
        `${providerLabel(platform)} OAuth is disabled in demonstration mode.`,
      );
      setWorking(null);
      return;
    }
    try {
      const result = await apiRequest<{ authorizationUrl: string }>(
        `/api/oauth/${platform}/start`,
        session,
        { method: "POST" },
      );
      window.location.assign(result.authorizationUrl);
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "The connection could not be started.",
      );
      setWorking(null);
    }
  }

  async function disconnect(account: ConnectedAccountSummary) {
    if (demoMode || !session) return;
    if (
      !window.confirm(
        `Disconnect ${providerLabel(account.platform)}? Postline will revoke provider access before removing its local credentials.`,
      )
    )
      return;
    setWorking(`disconnect:${account.id}`);
    setMessage("");
    try {
      const result = await apiRequest<{
        ok: boolean;
        providerRevoked?: boolean;
        revocationUncertain?: boolean;
        localCleanupPending?: boolean;
        disconnectCleanup?: ConnectedAccountSummary["disconnect_cleanup"];
      }>(`/api/accounts/${encodeURIComponent(account.id)}`, session, {
        method: "DELETE",
      });
      if (result.localCleanupPending && result.disconnectCleanup) {
        await refreshAccounts();
        setMessage(
          result.revocationUncertain
            ? `${providerLabel(account.platform)} revocation may have completed. Confirm local cleanup after checking provider access if needed.`
            : `${providerLabel(account.platform)} access was revoked. Confirm local cleanup to finish disconnecting safely.`,
        );
        return;
      }
      await refreshAccounts();
      setMessage(`${providerLabel(account.platform)} was disconnected.`);
    } catch (reason) {
      await refreshAccounts();
      setMessage(
        reason instanceof Error
          ? reason.message
          : "The account could not be disconnected safely.",
      );
    } finally {
      setWorking(null);
    }
  }

  async function confirmDisconnectCleanup(account: ConnectedAccountSummary) {
    if (demoMode || !session) return;
    let cleanup = account.disconnect_cleanup;
    if (!cleanup) return;
    setWorking(`cleanup:${account.id}`);
    setMessage("");
    try {
      const resumingProviderRevocation = cleanup.state === "prepared";
      if (
        resumingProviderRevocation ||
        new Date(cleanup.expiresAt).getTime() <= Date.now()
      ) {
        const resumed = await apiRequest<{
          ok: boolean;
          providerRevoked?: boolean;
          revocationUncertain?: boolean;
          localCleanupPending?: boolean;
          disconnectCleanup?: ConnectedAccountSummary["disconnect_cleanup"];
        }>(`/api/accounts/${encodeURIComponent(account.id)}`, session, {
          method: "DELETE",
        });
        if (resumed.ok) {
          await refreshAccounts();
          setMessage(`${providerLabel(account.platform)} was disconnected.`);
          return;
        }
        if (!resumed.localCleanupPending || !resumed.disconnectCleanup)
          throw new Error("Disconnect cleanup could not be resumed.");
        cleanup = resumed.disconnectCleanup;
        if (resumingProviderRevocation) {
          await refreshAccounts();
          setMessage(
            resumed.revocationUncertain
              ? `${providerLabel(account.platform)} revocation may have completed. Confirm local cleanup after checking provider access if needed.`
              : `${providerLabel(account.platform)} access was revoked. Confirm local cleanup to finish disconnecting safely.`,
          );
          return;
        }
      }
      await apiRequest(
        `/api/accounts/${encodeURIComponent(account.id)}/disconnect/confirm`,
        session,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: cleanup.operationId }),
        },
      );
      await refreshAccounts();
      setMessage(`${providerLabel(account.platform)} was disconnected.`);
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Local disconnection cleanup could not be confirmed.",
      );
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="accounts-page">
      <div className="page-intro">
        <p>
          Account state comes from the authenticated Worker. Credentials remain
          server-side and are never included in this response.
        </p>
        <a
          href="https://github.com/adeel1608/social-media-scheduler/blob/main/docs/PLATFORM_SUPPORT_MATRIX.md"
          target="_blank"
          rel="noreferrer"
        >
          View platform support <ArrowUpRight size={15} />
        </a>
      </div>
      {message && (
        <div className="inline-warning" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="inline-warning account-error" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
          {session && (
            <button
              className="soft-button"
              onClick={() => void refreshAccounts()}
            >
              <RefreshCw size={15} /> Retry
            </button>
          )}
        </div>
      )}
      {loading && (
        <div className="inline-warning" role="status" aria-live="polite">
          <RefreshCw className="spin" size={16} /> Checking authoritative
          account state...
        </div>
      )}
      <div className="account-grid" aria-busy={loading}>
        {providerDetails.map((provider) => {
          const providerAccounts = accounts.filter(
            (account) => account.platform === provider.platform,
          );
          const unavailable = Boolean(error) && providerAccounts.length === 0;
          const anyConnected = providerAccounts.some(
            (account) => account.connection_status === "connected",
          );
          return (
            <article className="account-card" key={provider.platform}>
              <div className="account-card-top">
                <PlatformBadge platform={provider.platform} />
                <span
                  aria-label={anyConnected ? "Connected" : "Not connected"}
                  className={`connection-dot ${anyConnected ? "online" : ""}`}
                />
              </div>
              {loading && providerAccounts.length === 0 ? (
                <div className="account-empty">
                  <h2>Checking account...</h2>
                  <p>{provider.type}</p>
                </div>
              ) : unavailable ? (
                <div className="account-empty">
                  <h2>State unavailable</h2>
                  <p>No connection claim is being made.</p>
                </div>
              ) : providerAccounts.length === 0 ? (
                <div className="account-empty">
                  <h2>Not connected</h2>
                  <p>{provider.type}</p>
                  <div className="account-status-list">
                    <span>
                      <Clock3 size={16} />
                      <div>
                        <small>ACCOUNT</small>
                        <strong>No server account found</strong>
                      </div>
                    </span>
                  </div>
                </div>
              ) : (
                <div className="connected-account-list">
                  {providerAccounts.map((account) => {
                    const connected = account.connection_status === "connected";
                    const approval = approvalStatus(account);
                    const approvalConfirmed =
                      account.approval_state === "approved" ||
                      account.approval_state === "not_required";
                    return (
                      <section className="connected-account" key={account.id}>
                        <h2>
                          {account.metadata.displayName ??
                            (account.username
                              ? `@${account.username.replace(/^@/, "")}`
                              : "Connected account")}
                        </h2>
                        <p>{account.metadata.accountType ?? provider.type}</p>
                        <div className="account-status-list">
                          <span
                            className={connected ? "positive" : "pending-text"}
                          >
                            {connected ? (
                              <CheckCircle2 size={16} />
                            ) : (
                              <Clock3 size={16} />
                            )}
                            <div>
                              <small>ACCOUNT</small>
                              <strong>{accountStatus(account)}</strong>
                            </div>
                          </span>
                          <span
                            className={
                              approvalConfirmed ? "positive" : "pending-text"
                            }
                          >
                            {approvalConfirmed ? (
                              <ShieldCheck size={16} />
                            ) : (
                              <Clock3 size={16} />
                            )}
                            <div>
                              <small>PROVIDER REVIEW</small>
                              <strong>{approval}</strong>
                            </div>
                          </span>
                          <span>
                            <LockKeyhole size={16} />
                            <div>
                              <small>CREDENTIALS</small>
                              <strong>Stored server-side</strong>
                            </div>
                          </span>
                        </div>
                        {account.disconnect_cleanup ? (
                          <button
                            className="danger-button compact"
                            onClick={() =>
                              void confirmDisconnectCleanup(account)
                            }
                            disabled={working === `cleanup:${account.id}`}
                          >
                            <Trash2 size={15} />
                            {account.disconnect_cleanup.state === "prepared"
                              ? "Resume disconnect"
                              : new Date(
                                    account.disconnect_cleanup.expiresAt,
                                  ).getTime() <= Date.now()
                                ? "Resume local cleanup"
                                : "Confirm local cleanup"}
                          </button>
                        ) : connected ? (
                          <button
                            className="danger-button compact"
                            onClick={() => void disconnect(account)}
                            disabled={working === `disconnect:${account.id}`}
                          >
                            <Trash2 size={15} /> Disconnect
                          </button>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              )}
              {!loading && !unavailable && (
                <button
                  className={
                    providerAccounts.length
                      ? "soft-button full"
                      : "primary-button full"
                  }
                  onClick={() => void connect(provider.platform)}
                  disabled={working === `connect:${provider.platform}`}
                >
                  {providerAccounts.length ? (
                    <>
                      <RefreshCw size={16} /> Connect another or reconnect
                    </>
                  ) : (
                    <>
                      <Plus size={16} /> Connect{" "}
                      {providerLabel(provider.platform)}
                    </>
                  )}
                </button>
              )}
            </article>
          );
        })}
      </div>
      <section className="security-callout">
        <span>
          <Link2 size={20} />
        </span>
        <div>
          <strong>Connections are installation-specific</strong>
          <p>
            Anyone cloning Postline connects their own platform apps and
            accounts. This repository does not provide shared credentials or a
            central publishing service.
          </p>
        </div>
      </section>
    </div>
  );
}
