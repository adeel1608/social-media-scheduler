import { ArrowRight, Check, LockKeyhole, WandSparkles } from "lucide-react";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";

import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "../components/TurnstileWidget";
import { useAuth } from "../context/AuthContext";

const repositoryUrl = "https://github.com/adeel1608/social-media-scheduler";

export function LoginPage() {
  const { sendMagicLink, signInMetaReviewer, session, demoMode, accessRole } =
    useAuth();
  const reviewRequested =
    new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    ).get("review") === "meta";
  const reviewEnabled = import.meta.env.VITE_META_REVIEW_MODE === "true";
  const reviewerLogin = reviewRequested && reviewEnabled;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [sending, setSending] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const turnstileReference = useRef<TurnstileWidgetHandle>(null);
  const turnstileSiteKey =
    import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? "";
  const updateCaptchaToken = useCallback((token: string) => {
    setCaptchaToken(token);
  }, []);
  if (session || demoMode)
    return (
      <Navigate
        to={accessRole === "meta_reviewer" ? "/accounts" : "/analytics"}
        replace
      />
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!captchaToken) {
      setMessageIsError(true);
      setMessage(
        reviewerLogin
          ? "Complete the security challenge before signing in."
          : "Complete the security challenge before requesting a sign-in link.",
      );
      return;
    }
    setSending(true);
    setMessage("");
    try {
      const result = reviewerLogin
        ? await signInMetaReviewer(email, password, captchaToken)
        : await sendMagicLink(email, captchaToken);
      setMessageIsError(Boolean(result.error));
      setMessage(
        result.error ??
          (reviewerLogin
            ? "Reviewer sign-in verified."
            : "Check your inbox. Your secure sign-in link is on its way."),
      );
    } catch {
      setMessageIsError(true);
      setMessage(
        reviewerLogin
          ? "The email or password could not be verified."
          : "The sign-in link could not be sent. Please try again later.",
      );
    } finally {
      turnstileReference.current?.reset();
      setCaptchaToken("");
      setSending(false);
    }
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
          <p className="eyebrow">
            {reviewerLogin ? "META REVIEWER ACCESS" : "OWNER ACCESS"}
          </p>
          <h2>{reviewerLogin ? "Review Postline" : "Welcome back"}</h2>
          <p className="muted" id="login-help">
            {reviewerLogin
              ? "Use the temporary credentials supplied privately with the Meta App Review submission."
              : "Enter the owner email configured for this installation. No password needed."}
          </p>
          {reviewRequested && !reviewEnabled && (
            <div className="form-message form-message-error" role="alert">
              Meta reviewer access is not enabled for this installation.{" "}
              <a href="/login">Return to owner sign-in</a>.
            </div>
          )}
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
            {reviewerLogin && (
              <>
                <label htmlFor="password">Temporary password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={12}
                  autoComplete="current-password"
                  aria-describedby="login-help"
                />
              </>
            )}
            <TurnstileWidget
              ref={turnstileReference}
              siteKey={turnstileSiteKey}
              onTokenChange={updateCaptchaToken}
              action={reviewerLogin ? "meta_reviewer_login" : "owner_login"}
              purpose={reviewerLogin ? "reviewer" : "owner"}
            />
            <button
              className="primary-button full"
              type="submit"
              disabled={
                sending ||
                !captchaToken ||
                !turnstileSiteKey ||
                (reviewRequested && !reviewEnabled)
              }
              aria-busy={sending}
            >
              {sending
                ? reviewerLogin
                  ? "Signing in…"
                  : "Sending link…"
                : reviewerLogin
                  ? "Sign in for Meta review"
                  : "Send magic link"}
              <ArrowRight size={17} />
            </button>
          </form>
          {message && (
            <div
              className={`form-message${messageIsError ? " form-message-error" : ""}`}
              role={messageIsError ? "alert" : "status"}
            >
              {message}
            </div>
          )}
          <p className="login-note">
            {reviewerLogin ? (
              <>
                This temporary account can access only its own Instagram review
                workspace. Public registration remains disabled.
              </>
            ) : (
              <>
                This hosted URL is one owner&apos;s private installation. For
                your own installation, use the public{" "}
                <a href={repositoryUrl}>Postline repository</a>. Other
                authenticated email addresses are denied by server and database
                policies.
              </>
            )}
          </p>
          {!reviewerLogin && reviewEnabled && (
            <p className="login-note">
              <a href="/login?review=meta">Meta App Review sign-in</a>
            </p>
          )}
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
