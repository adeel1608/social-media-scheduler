import {
  ArrowUpRight,
  Check,
  CircleDashed,
  KeyRound,
  Server,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

interface SetupStatus {
  configured: boolean;
  services: {
    databaseAuth: boolean;
    mediaStorage: boolean;
    notifications: boolean;
  };
  approvals: Record<"instagram" | "tiktok" | "youtube", boolean>;
  liveTestSafetyEnabled: boolean;
  environment: string;
}

interface ConnectedAccount {
  platform: "instagram" | "tiktok" | "youtube";
  connection_status: string;
}

const demoStatus: SetupStatus = {
  configured: false,
  services: {
    databaseAuth: true,
    mediaStorage: true,
    notifications: false,
  },
  approvals: { instagram: true, tiktok: false, youtube: false },
  liveTestSafetyEnabled: false,
  environment: "local demonstration",
};

export function SetupPage() {
  const { demoMode, session } = useAuth();
  const [status, setStatus] = useState<SetupStatus | null>(
    demoMode ? demoStatus : null,
  );
  const [accounts, setAccounts] = useState<ConnectedAccount[]>(
    demoMode
      ? [
          { platform: "instagram", connection_status: "connected" },
          { platform: "youtube", connection_status: "connected" },
        ]
      : [],
  );
  const [error, setError] = useState("");

  useEffect(() => {
    if (demoMode || !session) return;
    void Promise.all([
      apiRequest<SetupStatus>("/api/setup", session),
      apiRequest<{ data: ConnectedAccount[] }>("/api/accounts", session),
    ])
      .then(([nextStatus, accountResult]) => {
        setStatus(nextStatus);
        setAccounts(accountResult.data);
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Configuration status could not be loaded.",
        ),
      );
  }, [demoMode, session]);

  const connected = (platform: ConnectedAccount["platform"]) =>
    accounts.some(
      (account) =>
        account.platform === platform &&
        account.connection_status === "connected",
    );
  const steps = useMemo(
    () => [
      {
        title: "Supabase database & auth",
        detail: status?.services.databaseAuth
          ? "Keys present · verify migrations and owner allowlist"
          : "Project URL or API keys still required",
        ready: Boolean(status?.services.databaseAuth),
      },
      {
        title: "Cloudflare Worker, Queue & UploadThing",
        detail: status?.services.mediaStorage
          ? "Worker URL and UploadThing server token are present"
          : "Worker URL or UploadThing server token still required",
        ready: Boolean(status?.services.mediaStorage),
      },
      {
        title: "Resend failure notifications",
        detail: status?.services.notifications
          ? "Credentials present · verify sender eligibility and recipient scope"
          : "API key and an eligible sender are still required",
        ready: Boolean(status?.services.notifications),
      },
      {
        title: "Instagram professional account",
        detail: !connected("instagram")
          ? "OAuth connection required"
          : status?.approvals.instagram
            ? "Connected · Meta review marked approved"
            : "Connected · Meta app review still required",
        ready: connected("instagram") && Boolean(status?.approvals.instagram),
      },
      {
        title: "TikTok Content Posting API",
        detail: !connected("tiktok")
          ? "OAuth connection and content-posting audit required"
          : status?.approvals.tiktok
            ? "Connected · public-post audit marked approved"
            : "Connected · public-post audit still required",
        ready: connected("tiktok") && Boolean(status?.approvals.tiktok),
      },
      {
        title: "YouTube Data & Analytics APIs",
        detail: !connected("youtube")
          ? "OAuth connection and upload audit required"
          : status?.approvals.youtube
            ? "Connected · upload audit marked approved"
            : "Connected · upload audit still required for public posts",
        ready: connected("youtube") && Boolean(status?.approvals.youtube),
      },
    ],
    [accounts, status],
  );
  const readyCount = steps.filter((step) => step.ready).length;
  const percentage = Math.round((readyCount / steps.length) * 100);

  return (
    <div className="setup-page">
      <section className="setup-hero">
        <div>
          <span className="story-kicker">
            <Sparkles size={15} /> {readyCount} of {steps.length} services ready
          </span>
          <h2>
            Finish the human steps,
            <br />
            then let the queue run.
          </h2>
          <p>
            This page reports presence and approval state, never secret values.
            Provider dashboards still require consent, domain verification and
            review.
          </p>
          {error && <p className="form-error">{error}</p>}
        </div>
        <div
          className="setup-ring"
          style={{ "--progress": `${percentage}%` } as CSSProperties}
        >
          <div>
            <strong>{percentage}%</strong>
            <small>configured</small>
          </div>
        </div>
      </section>
      <section className="panel setup-list" aria-busy={!status}>
        {steps.map((step, index) => (
          <div className="setup-row" key={step.title}>
            <span
              className={`setup-number ${step.ready ? "ready" : "pending"}`}
            >
              {step.ready ? <Check size={17} /> : index + 1}
            </span>
            <div>
              <strong>{step.title}</strong>
              <p>{status ? step.detail : "Checking configuration…"}</p>
            </div>
            <span className={`setup-state ${step.ready ? "ready" : "pending"}`}>
              {step.ready ? "Ready" : "Human action"}
            </span>
            <a
              href={
                step.title.startsWith("TikTok")
                  ? "https://developers.tiktok.com/"
                  : step.title.startsWith("YouTube")
                    ? "https://console.cloud.google.com/"
                    : "https://github.com/adeel1608/social-media-scheduler/blob/main/HUMAN_SETUP.md"
              }
              target="_blank"
              rel="noreferrer"
              aria-label={`Open setup for ${step.title}`}
            >
              <ArrowUpRight size={17} />
            </a>
          </div>
        ))}
      </section>
      <div className="setup-bottom-grid">
        <section className="panel compact-panel">
          <span className="metric-icon peach">
            <KeyRound size={19} />
          </span>
          <div>
            <h3>Configuration doctor</h3>
            <p>
              {status?.configured
                ? "Required settings are present. Run the doctor for format and connectivity checks."
                : "One or more required settings need attention. Run the doctor locally for names and format checks."}
            </p>
            <code>corepack pnpm setup-doctor</code>
          </div>
        </section>
        <section className="panel compact-panel warning-panel">
          <span className="metric-icon gold">
            <ShieldAlert size={19} />
          </span>
          <div>
            <h3>
              Publishing safety is{" "}
              {status?.liveTestSafetyEnabled ? "off" : "on"}
            </h3>
            <p>
              {status?.liveTestSafetyEnabled
                ? "LIVE_TEST_CONFIRM is enabled. Use only with the owner's explicit approval."
                : "Real API publication remains disabled until LIVE_TEST_CONFIRM=true is set intentionally."}
            </p>
          </div>
        </section>
      </div>
      <div className="environment-line">
        <Server size={15} /> {status?.environment ?? "Checking environment"}{" "}
        <CircleDashed size={14} /> Platform approvals{" "}
        {Object.values(status?.approvals ?? {}).every(Boolean)
          ? "confirmed"
          : "pending"}
      </div>
    </div>
  );
}
