import {
  Database,
  Download,
  ExternalLink,
  KeyRound,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useAuth } from "../context/AuthContext";
import { apiRequest } from "../lib/api";

export function SettingsPage() {
  const { demoMode, session, signOut } = useAuth();
  const [message, setMessage] = useState("");
  const [storage, setStorage] = useState({
    activeBytes: demoMode ? 340 * 1024 ** 2 : 0,
    reservedBytes: 0,
    limitBytes: Math.floor(1.8 * 1024 ** 3),
  });

  useEffect(() => {
    if (demoMode || !session) return;
    void apiRequest<typeof storage>("/api/storage", session)
      .then(setStorage)
      .catch((reason: unknown) =>
        setMessage(
          reason instanceof Error
            ? reason.message
            : "Storage usage could not be loaded.",
        ),
      );
  }, [demoMode, session]);

  async function exportData() {
    if (demoMode || !session) {
      setMessage("Export is disabled in demonstration mode.");
      return;
    }
    try {
      const data = await apiRequest<Record<string, unknown>>(
        "/api/export",
        session,
      );
      const link = document.createElement("a");
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        }),
      );
      link.download = `postline-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      setMessage("A secrets-excluded installation export was downloaded.");
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Export could not be created.",
      );
    }
  }

  async function deleteInstallation() {
    if (demoMode || !session) {
      setMessage("Data deletion is disabled in demonstration mode.");
      return;
    }
    const confirmation = window.prompt(
      "This permanently removes scheduler data and UploadThing source media. Published platform content remains. Type DELETE to continue.",
    );
    if (confirmation !== "DELETE") return;
    try {
      const result = await apiRequest<{
        authUserDeleted: boolean;
        providerRevocationIncomplete: string[];
      }>("/api/installation/delete", session, {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      });
      const localResult = result.authUserDeleted
        ? "Installation data and the Supabase Auth user were deleted."
        : "Installation data was deleted. Remove the remaining Auth user in Supabase if it still appears.";
      const revocationResult = result.providerRevocationIncomplete.length
        ? ` External authorization could not be confirmed revoked for: ${result.providerRevocationIncomplete.join(", ")}. Remove Postline from those provider permission pages.`
        : " Provider revocation completed for every stored connection.";
      setMessage(`${localResult}${revocationResult}`);
      await signOut();
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Installation data could not be deleted.",
      );
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-grid">
        <section className="panel settings-section">
          <div className="settings-title">
            <span>
              <ShieldCheck size={20} />
            </span>
            <div>
              <h2>Installation owner</h2>
              <p>
                The server validates this address on every state-changing
                request.
              </p>
            </div>
          </div>
          <label className="field-label">
            Owner email
            <input
              type="email"
              value={
                demoMode ? "owner@example.com" : (session?.user.email ?? "")
              }
              disabled
              readOnly
            />
            <small>
              Change OWNER_EMAIL and the installation record together during
              maintenance.
            </small>
          </label>
          <label className="field-label">
            Notification email
            <input
              type="text"
              value="Configured server-side in NOTIFICATION_EMAIL"
              disabled
              readOnly
            />
          </label>
          <a className="soft-button" href="/setup">
            <Save size={16} /> Review configuration status
          </a>
        </section>
        <section className="panel settings-section">
          <div className="settings-title">
            <span>
              <KeyRound size={20} />
            </span>
            <div>
              <h2>Security</h2>
              <p>Token encryption, session expiry and live-publish controls.</p>
            </div>
          </div>
          <div className="setting-line">
            <span>
              <strong>Token encryption</strong>
              <small>AES-256-GCM · key version v1</small>
            </span>
            <span className="positive">Active</span>
          </div>
          <div className="setting-line">
            <span>
              <strong>Live publishing</strong>
              <small>Requires an intentional environment flag</small>
            </span>
            <span className="pending-text">Safety on</span>
          </div>
          <div className="setting-line">
            <span>
              <strong>Session policy</strong>
              <small>Supabase magic link · local sign-out</small>
            </span>
            <span className="positive">Active</span>
          </div>
          <a
            className="soft-button"
            href="https://github.com/adeel1608/social-media-scheduler/blob/main/SECURITY.md"
            target="_blank"
            rel="noreferrer"
          >
            Security guide <ExternalLink size={15} />
          </a>
        </section>
        <section className="panel settings-section">
          <div className="settings-title">
            <span>
              <Database size={20} />
            </span>
            <div>
              <h2>Data & storage</h2>
              <p>
                Metadata remains; successful source media is removed after seven
                days.
              </p>
            </div>
          </div>
          <div className="storage-meter">
            <div>
              <strong>{formatBytes(storage.activeBytes)} counted</strong>
              <small>
                {storage.reservedBytes
                  ? `${formatBytes(storage.reservedBytes)} reserved by uploads`
                  : "No upload reservations pending"}
              </small>
            </div>
            <span>
              <i
                style={{
                  width: `${Math.min(100, (storage.activeBytes / storage.limitBytes) * 100)}%`,
                }}
              />
            </span>
            <small>
              Postline limit: {formatBytes(storage.limitBytes)} of UploadThing
              Free&apos;s finite 2 GB. Provider files remain public-readable
              through opaque URLs.
            </small>
          </div>
          <button className="soft-button" onClick={() => void exportData()}>
            <Download size={16} /> Export installation data
          </button>
        </section>
        <section className="panel settings-section danger-section">
          <div className="settings-title">
            <span>
              <Trash2 size={20} />
            </span>
            <div>
              <h2>Delete installation data</h2>
              <p>
                Revokes connections and removes scheduler records. Platform
                content is not deleted.
              </p>
            </div>
          </div>
          <button
            className="danger-button"
            onClick={() => void deleteInstallation()}
          >
            <Trash2 size={16} /> Start data deletion
          </button>
        </section>
      </div>
      {message && <p className="form-message">{message}</p>}
      <div className="footer-links">
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Use</a>
        <a href="/data-deletion">Data Deletion Instructions</a>
      </div>
    </div>
  );
}

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MiB`;
  return `${Math.max(0, Math.round(value / 1024))} KiB`;
}
