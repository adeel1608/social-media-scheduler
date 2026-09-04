import { ArrowRight, Check, LockKeyhole, WandSparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { sendMagicLink, session, demoMode } = useAuth();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  if (session || demoMode) return <Navigate to="/analytics" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    const result = await sendMagicLink(email);
    setMessage(
      result.error ??
        "Check your inbox. Your secure sign-in link is on its way.",
    );
    setSending(false);
  }

  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand brand-light">
          <span className="brand-mark">P</span>
          <span className="brand-word">postline</span>
        </div>
        <div className="story-copy">
          <span className="story-kicker">
            <WandSparkles size={15} /> One calm place to publish
          </span>
          <h1>
            Your ideas,
            <br />
            right on time.
          </h1>
          <p>
            Schedule Instagram, TikTok and YouTube from a private workspace you
            control.
          </p>
          <div className="story-list">
            <span>
              <Check size={16} /> No application-level queue limit
            </span>
            <span>
              <Check size={16} /> Your credentials stay in your instance
            </span>
            <span>
              <Check size={16} /> No surprise automatic retries
            </span>
          </div>
        </div>
        <p className="story-foot">
          Open source · MIT licensed · Built for one owner
        </p>
      </section>
      <section className="login-form-panel">
        <div className="login-card">
          <div className="login-icon">
            <LockKeyhole size={22} />
          </div>
          <p className="eyebrow">OWNER ACCESS</p>
          <h2>Welcome back</h2>
          <p className="muted" id="login-help">
            Enter the owner email configured for this installation. No password
            needed.
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              aria-describedby="login-help"
            />
            <button
              className="primary-button full"
              type="submit"
              disabled={sending}
              aria-busy={sending}
            >
              {sending ? "Sending link…" : "Send magic link"}
              <ArrowRight size={17} />
            </button>
          </form>
          {message && (
            <div className="form-message" role="status">
              {message}
            </div>
          )}
          <p className="login-note">
            Other authenticated email addresses are denied by the server and
            database policies.
          </p>
          <div className="legal-links">
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/data-deletion">Data deletion</a>
          </div>
        </div>
      </section>
    </div>
  );
}
