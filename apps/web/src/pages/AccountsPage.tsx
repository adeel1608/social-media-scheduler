import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";

import { PlatformBadge } from "../components/PlatformBadge";
import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

const accounts = [
  {
    platform: "instagram" as const,
    handle: "@adeel.creates",
    type: "Professional creator",
    status: "Connected",
    approval: "Publishing approved",
    connected: true,
  },
  {
    platform: "tiktok" as const,
    handle: "Not connected",
    type: "Content Posting API",
    status: "Setup needed",
    approval: "Public-post audit pending",
    connected: false,
  },
  {
    platform: "youtube" as const,
    handle: "Adeel Creates",
    type: "YouTube channel",
    status: "Connected",
    approval: "API audit pending",
    connected: true,
  },
];

export function AccountsPage() {
  const { demoMode, session } = useAuth();
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  async function connect(platform: string) {
    setWorking(platform);
    if (demoMode || !session) {
      setMessage(`${platform} OAuth is disabled in local demonstration mode.`);
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
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not start connection",
      );
      setWorking(null);
    }
  }

  return (
    <div className="accounts-page">
      <div className="page-intro">
        <p>
          Connect only the owner’s professional accounts. OAuth credentials are
          encrypted before storage and never reach browser code after
          connection.
        </p>
        <a href="/docs/PLATFORM_SUPPORT_MATRIX.md">
          View platform support <ArrowUpRight size={15} />
        </a>
      </div>
      {message && (
        <div className="inline-warning" role="status">
          {message}
        </div>
      )}
      <div className="account-grid">
        {accounts.map((account) => (
          <article className="account-card" key={account.platform}>
            <div className="account-card-top">
              <PlatformBadge platform={account.platform} />
              <span
                className={`connection-dot ${account.connected ? "online" : ""}`}
              />
            </div>
            <h2>{account.handle}</h2>
            <p>{account.type}</p>
            <div className="account-status-list">
              <span>
                {account.connected ? (
                  <CheckCircle2 size={16} />
                ) : (
                  <Clock3 size={16} />
                )}
                <div>
                  <small>ACCOUNT</small>
                  <strong>{account.status}</strong>
                </div>
              </span>
              <span
                className={
                  account.approval.includes("pending")
                    ? "pending-text"
                    : "positive"
                }
              >
                {account.approval.includes("pending") ? (
                  <Clock3 size={16} />
                ) : (
                  <ShieldCheck size={16} />
                )}
                <div>
                  <small>PUBLIC PUBLISHING</small>
                  <strong>{account.approval}</strong>
                </div>
              </span>
              <span>
                <LockKeyhole size={16} />
                <div>
                  <small>TOKENS</small>
                  <strong>
                    {account.connected ? "Encrypted · AES-GCM" : "Not stored"}
                  </strong>
                </div>
              </span>
            </div>
            <button
              className={
                account.connected ? "soft-button full" : "primary-button full"
              }
              onClick={() => void connect(account.platform)}
              disabled={working === account.platform}
            >
              {account.connected ? (
                <>
                  <RefreshCw size={16} /> Reconnect account
                </>
              ) : (
                <>
                  <Plus size={16} /> Connect {account.platform}
                </>
              )}
            </button>
          </article>
        ))}
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
